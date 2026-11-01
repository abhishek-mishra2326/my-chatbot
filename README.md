# Saathi: Full-Stack AI Chatbot with Document Q&A (RAG)

A full-stack AI chatbot with secure user accounts, saved chat history, real-time streaming, and document question answering. Users upload PDF, TXT or Markdown files and get answers grounded in their own documents, with source citations.

**Live demo:** https://my-chatbot-i8jv.onrender.com

> Hosted on free-tier services, so the first load can take up to a minute, and AI usage limits may apply.

## Features

- **Document Q&A (RAG):** upload PDF, TXT or MD files, then ask questions about them. Answers cite the source file and the part used
- **Real-time streaming** responses with a Stop button
- **User accounts:** sign up, log in, log out, with per-user chat history stored in a database
- **Chat management:** reopen or delete past conversations from the sidebar
- **Responsive glass-style UI** for desktop and mobile, with dark and light themes
- **Paperclip upload button** inside the message box, like modern chat apps
- **Resilient AI calls:** timeouts, automatic retries and an optional fallback model
- **Abuse protection:** per-IP rate limiting and strict input validation

## How It Works

```
Browser (HTML/CSS/JS)  →  FastAPI backend  →  Gemini API (chat + embeddings)
                               │
                               └→  Database (SQLite locally, PostgreSQL in production)
```

### Document Q&A pipeline (RAG)

```
Upload:  file → extract text → split into chunks → embed each chunk → store vectors in the database
Ask:     question → embed → rank the user's chunks by cosine similarity → top 4 → prompt the model → answer + sources
```

1. **Chunking:** text is split into roughly 900-character chunks with a 150-character overlap, cutting at paragraph or sentence boundaries where possible
2. **Embeddings:** each chunk is embedded with `gemini-embedding-001` (768 dimensions) and stored as compact binary vectors
3. **Retrieval:** the question is embedded and compared with the user's chunks using cosine similarity, and the top 4 chunks are selected
4. **Grounded answer:** the model is told to answer only from the numbered excerpts, to cite them, and to say so when the answer is not in the documents
5. **Sources:** the cited files and parts are returned to the browser and shown under the answer

Similarity search runs in plain Python over each user's chunks. This is simple and fast enough for small per-user document sets, and it works the same on SQLite and PostgreSQL.

## Tech Stack

- **Backend:** Python, FastAPI, Uvicorn, SQLAlchemy
- **AI:** Google Gemini API (`google-genai`) for chat and embeddings
- **Database:** SQLite (local), PostgreSQL on Neon (production)
- **Document parsing:** pypdf
- **Frontend:** HTML, CSS, vanilla JavaScript
- **Rate limiting:** slowapi
- **Deployment:** Render (auto-deploy from GitHub)

## Project Structure

```
my-chatbot/
├── main.py            # API routes, auth, RAG pipeline, streaming
├── database.py        # SQLAlchemy models and database setup
├── requirements.txt   # Python dependencies
├── static/
│   ├── index.html
│   ├── style.css
│   └── script.js
└── .gitignore
```

## API Overview

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/signup`, `/api/login`, `/api/logout` | Authentication |
| GET | `/api/me` | Current user |
| GET | `/api/conversations` | List the user's chats |
| GET / DELETE | `/api/conversations/{id}` | Open or delete a chat |
| POST | `/api/documents` | Upload and index a document |
| GET | `/api/documents` | List the user's documents |
| DELETE | `/api/documents/{id}` | Delete a document and its chunks |
| POST | `/api/chat-stream` | Stream an answer (optionally grounded in documents) |
| GET | `/health` | Health check |

Interactive docs are available at `/docs` when running locally.

## Running Locally

1. Clone the repository:
   ```bash
   git clone https://github.com/abhishek-mishra2326/my-chatbot.git
   cd my-chatbot
   ```
2. Create and activate a virtual environment:
   ```bash
   python -m venv venv
   venv\Scripts\activate        # macOS/Linux: source venv/bin/activate
   ```
3. Install the dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Create a `.env` file in the project root:
   ```
   GEMINI_API_KEY=your-api-key
   GEMINI_MODEL=your-chat-model-name
   ```
   You can get a free API key from [Google AI Studio](https://aistudio.google.com/apikey).
5. Start the server:
   ```bash
   python -m uvicorn main:app --reload --port 8001
   ```
6. Open `http://127.0.0.1:8001`, create an account, upload a document and start asking questions.

A local SQLite database (`chatbot.db`) is created automatically on first run.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Your Gemini API key |
| `GEMINI_MODEL` | No | Primary chat model |
| `GEMINI_FALLBACK_MODEL` | No | Backup chat model used if the primary one fails |
| `EMBED_MODEL` | No | Embedding model (default: `gemini-embedding-001`) |
| `DATABASE_URL` | No | PostgreSQL connection string. If not set, a local SQLite file is used |
| `COOKIE_SECURE` | No | Set to `1` in production (HTTPS) so the login cookie is sent securely |
| `MOCK` | No | Set to `1` to test without calling the AI API (fake replies and simple local embeddings) |

## Security

- Passwords are hashed with scrypt and a per-user salt, never stored in plain text
- Sessions use random tokens in `HttpOnly` cookies, and only a SHA-256 hash of each token is stored
- Every chat and document is checked against the logged-in user, so users cannot access each other's data
- The API key lives only in server-side environment variables, and `.env` is never committed
- Uploads are limited by file type, size, page count and text length
- Document excerpts are treated as untrusted data, and the model is instructed to ignore any instructions found inside them (a basic prompt-injection mitigation)
- Requests are rate limited per IP address, with stricter limits on login and signup
- User content is rendered safely in the browser to prevent XSS

## Limitations

- The Gemini free tier has shared limits across the whole app, so heavy use may trigger a "usage limit reached" message
- On Render's free plan the app sleeps when idle, so the first load can take 30-60 seconds
- Scanned (image-only) PDFs are not supported, because no OCR is used
- Each user can store up to 5 documents (5 MB, 60 pages and about 60,000 characters each)
- Vector search runs in Python and suits small document sets, and a vector database such as pgvector would be the next step for scale
- Chats and document text are stored unencrypted and sent to the Gemini API, so sensitive documents should not be uploaded
- Source citations are shown live but are not stored with past chats
- No password reset or email verification yet

## Roadmap

- [x] Streaming responses
- [x] User login and persistent chat history
- [x] Retrieval-Augmented Generation (RAG) over custom PDFs and notes
- [ ] Tool use and function calling
- [ ] Password reset and email verification
- [ ] pgvector for larger document collections

## What I Learned

Building a REST API with FastAPI, streaming responses, secure authentication with hashed passwords and session cookies, relational database design with SQLAlchemy, retrieval-augmented generation (chunking, embeddings, cosine similarity, grounded prompting), API key security, rate limiting, retry and fallback logic, responsive UI design, and Git and cloud deployment with PostgreSQL.

## Author

[ABHISHEK MISHRA] | [www.linkedin.com/in/abhishek-mishra2326]