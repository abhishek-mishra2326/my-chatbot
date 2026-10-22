import os
import time
from dotenv import load_dotenv
load_dotenv()

from google import genai
from google.genai import types, errors
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

client = genai.Client()   # GEMINI_API_KEY environment / .env se khud padh leta hai
app = FastAPI()

# ---------- Rate limiting (har IP ke liye) ----------
def get_client_ip(request: Request) -> str:
    # Render proxy ke peeche hota hai, isliye asli IP header se lo
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host

limiter = Limiter(key_func=get_client_ip)
app.state.limiter = limiter

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Bahut zyada messages bheje, 1 minute ruk ke try karo."},
    )

# ---------- Model settings ----------
# Pehle main model, fail hua to fallback model (agar .env mein diya ho)
MODELS = [m for m in [
    os.getenv("GEMINI_MODEL", "gemini-3.8-flash"),
    os.getenv("GEMINI_FALLBACK_MODEL"),
] if m]

SYSTEM_PROMPT = "Tum ek helpful, friendly assistant ho. Jawab chhote aur clear rakho."

class Message(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=2000)

class ChatRequest(BaseModel):
    messages: list[Message] = Field(max_length=20)

# ---------- Routes ----------
@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/api/chat")
@limiter.limit("4/minute")
def chat(request: Request, req: ChatRequest):
    # Gemini mein "assistant" ki jagah "model" role hota hai
    contents = [
        types.Content(
            role="model" if m.role == "assistant" else "user",
            parts=[types.Part(text=m.content)],
        )
        for m in req.messages
    ]
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        max_output_tokens=1000,
    )

    last_code = None
    for model in MODELS:
        for attempt in range(2):
            try:
                response = client.models.generate_content(
                    model=model, contents=contents, config=config
                )
                return {"reply": response.text or "Jawab nahi mil paya, dobara try karo."}
            except errors.APIError as e:
                last_code = e.code
                print(f"Error ({model}, try {attempt + 1}):", e)
                # Sirf server-side load (5xx) par ek baar retry.
                # 429 par retry karne se quota aur jalta hai, isliye seedha dusre model par jao.
                if e.code in (500, 503, 504) and attempt == 0:
                    time.sleep(2)
                    continue
                break
            except Exception as e:
                print("Error:", e)
                break

    if last_code == 429:
        raise HTTPException(
            status_code=429,
            detail="Free limit abhi khatam ho gayi hai, 1 minute ruk ke try karo.",
        )
    raise HTTPException(
        status_code=503,
        detail="AI abhi busy hai, thodi der baad dobara try karo.",
    )

# Frontend serve karo (ye line sabse neeche rehni chahiye)
app.mount("/", StaticFiles(directory=os.path.join(BASE_DIR, "static"), html=True), name="static")