import os
import time
import hmac
import hashlib
import secrets
from datetime import timedelta
from dotenv import load_dotenv
load_dotenv()

from google import genai
from google.genai import types, errors
from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from sqlalchemy import select, delete
from sqlalchemy.orm import Session

from database import Base, engine, SessionLocal, User, AuthSession, Conversation, Message, now

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
Base.metadata.create_all(bind=engine)   # tables nahi hain to bana deta hai

client = genai.Client()
app = FastAPI()

# ---------- Rate limiting ----------
def get_client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else request.client.host

limiter = Limiter(key_func=get_client_ip)
app.state.limiter = limiter

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content={"detail": "Too many requests. Please wait a minute and try again."})

# ---------- Settings ----------
MODELS = [m for m in [
    os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
    os.getenv("GEMINI_FALLBACK_MODEL"),
] if m]
SYSTEM_PROMPT = (
    "You are Saathi, a helpful, friendly and professional AI assistant. "
    "Keep answers clear and concise. Reply in the same language the user writes in."
)
COOKIE = "saathi_session"
SESSION_DAYS = 14
SECURE_COOKIE = os.getenv("COOKIE_SECURE") == "1"   # Render (https) par 1 rakhna

# ---------- Password hashing (standard library ka scrypt) ----------
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return salt.hex() + "$" + h.hex()

def verify_password(pw: str, stored: str) -> bool:
    try:
        salt_hex, h_hex = stored.split("$")
        h = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(h.hex(), h_hex)
    except Exception:
        return False

# ---------- Sessions ----------
def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

def start_session(db: Session, user_id: int, response: Response):
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(token_hash=token_hash(token), user_id=user_id,
                       expires_at=now() + timedelta(days=SESSION_DAYS)))
    db.commit()
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=SECURE_COOKIE)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE)
    if token:
        s = db.get(AuthSession, token_hash(token))
        if s and s.expires_at > now():
            user = db.get(User, s.user_id)
            if user:
                return user
    raise HTTPException(status_code=401, detail="Please log in first.")

# ---------- Request schemas ----------
EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"

class Credentials(BaseModel):
    email: str = Field(pattern=EMAIL_RE, max_length=255)
    password: str = Field(min_length=8, max_length=128)

class ChatRequest(BaseModel):
    conversation_id: int | None = None
    message: str = Field(min_length=1, max_length=2000)

# ---------- Auth routes ----------
@app.post("/api/signup")
@limiter.limit("5/minute")
def signup(request: Request, creds: Credentials, response: Response, db: Session = Depends(get_db)):
    email = creds.email.strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=409, detail="An account with this email already exists. Please log in.")
    user = User(email=email, password_hash=hash_password(creds.password))
    db.add(user)
    db.commit()
    start_session(db, user.id, response)
    return {"email": user.email}

@app.post("/api/login")
@limiter.limit("10/minute")
def login(request: Request, creds: Credentials, response: Response, db: Session = Depends(get_db)):
    email = creds.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    if not user or not verify_password(creds.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    start_session(db, user.id, response)
    return {"email": user.email}

@app.post("/api/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE)
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash(token)))
        db.commit()
    response.delete_cookie(COOKIE)
    return {"ok": True}

@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return {"email": user.email}

# ---------- Conversation routes ----------
def own_conversation(db: Session, cid: int, user: User) -> Conversation:
    conv = db.get(Conversation, cid)
    if not conv or conv.user_id != user.id:      # dusre user ki chat kabhi nahi dikhni chahiye
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conv

@app.get("/api/conversations")
def list_conversations(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Conversation).where(Conversation.user_id == user.id)
                      .order_by(Conversation.updated_at.desc()).limit(50)).all()
    return [{"id": c.id, "title": c.title} for c in rows]

@app.get("/api/conversations/{cid}")
def get_conversation(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    conv = own_conversation(db, cid, user)
    msgs = db.scalars(select(Message).where(Message.conversation_id == cid).order_by(Message.id)).all()
    return {"id": conv.id, "title": conv.title,
            "messages": [{"role": m.role, "content": m.content} for m in msgs]}

@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    conv = own_conversation(db, cid, user)
    db.execute(delete(Message).where(Message.conversation_id == cid))
    db.delete(conv)
    db.commit()
    return {"ok": True}

# ---------- Streaming helpers ----------
def text_stream(contents, config):
    """Pehla chunk aane tak retry/fallback. Return: (pehla text, baaki texts ka iterator)."""
    last_code = None
    for model in MODELS:
        for attempt in range(2):
            try:
                it = iter(client.models.generate_content_stream(model=model, contents=contents, config=config))
                first = next(it)
                return (first.text or ""), (c.text or "" for c in it)
            except StopIteration:
                return "", iter(())
            except errors.APIError as e:
                last_code = e.code
                print(f"Error ({model}, try {attempt + 1}):", e)
                if e.code in (500, 503, 504) and attempt == 0:
                    time.sleep(2)
                    continue
                break
            except Exception as e:
                print("Error:", e)
                break
    if last_code == 429:
        raise HTTPException(status_code=429, detail="The AI usage limit has been reached. Please try again later.")
    raise HTTPException(status_code=503, detail="The AI service is busy. Please try again in a moment.")

def mock_stream(message: str):
    text = f"**Test mode:** you wrote: {message}\n\n- this is a placeholder reply\n- chat history is being saved to the database"
    def gen():
        for w in text.split(" "):
            yield w + " "
            time.sleep(0.05)
    it = gen()
    return next(it), it

# ---------- Chat ----------
@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/api/chat-stream")
@limiter.limit("6/minute")
def chat_stream(request: Request, req: ChatRequest,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    conv = None
    history = []
    if req.conversation_id:
        conv = own_conversation(db, req.conversation_id, user)
        past = db.scalars(select(Message).where(Message.conversation_id == conv.id)
                          .order_by(Message.id.desc()).limit(20)).all()
        history = [(m.role, m.content) for m in reversed(past)]
    history.append(("user", req.message))
    while history[0][0] != "user":          # Gemini ko pehla message user ka chahiye
        history.pop(0)

    # Pehle AI se stream kholo. Fail hua to koi khaali chat ya orphan message save nahi hoga
    if os.getenv("MOCK") == "1":
        first, it = mock_stream(req.message)
    else:
        contents = [types.Content(role="model" if r == "assistant" else "user",
                                  parts=[types.Part(text=c)]) for r, c in history]
        config = types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT, max_output_tokens=1000)
        first, it = text_stream(contents, config)

    if conv is None:
        conv = Conversation(user_id=user.id, title=req.message.strip()[:50] or "New chat")
        db.add(conv)
        db.commit()
    cid = conv.id
    db.add(Message(conversation_id=cid, role="user", content=req.message))
    conv.updated_at = now()
    db.commit()

    def generate():
        parts = []
        try:
            if first:
                parts.append(first)
                yield first
            for t in it:
                if t:
                    parts.append(t)
                    yield t
        except Exception as e:
            print("Stream error:", e)
            yield "\n\n(The response was interrupted. Please try again.)"
        finally:
            # Stop dabane par bhi jitna jawab aaya wo save ho jata hai
            text = "".join(parts).strip()
            if text:
                with SessionLocal() as s:
                    s.add(Message(conversation_id=cid, role="assistant", content=text))
                    c = s.get(Conversation, cid)
                    if c:
                        c.updated_at = now()
                    s.commit()

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Conversation-Id": str(cid)}
    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8", headers=headers)

# Frontend serve karo (ye line sabse neeche)
app.mount("/", StaticFiles(directory=os.path.join(BASE_DIR, "static"), html=True), name="static")