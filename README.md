# 24askme AI Backend

Presidential‑level conversational AI for **24askme.com** – Rwanda's 24/7 service gateway.

## Capabilities

- ✅ **General Rwanda Q&A (conversational RAG)** – answers questions about visas, taxes, safety, events, cost of living, etc., using official government sources. The AI can ask clarifying questions (e.g., “Which type of visa?”) before retrieving information.
- ✅ **Accommodation search (conversational)** – finds houses, apartments, guesthouses, Airbnbs by asking for budget, area, bedrooms.
- ✅ **Human handoff** – after providing information or options, offers to connect to a real concierge via WhatsApp with context.
- 🚧 **Extensible** – new services (transport, jobs, government procedures) can be added by implementing new intent handlers.

## Tech Stack

- Node.js + Express
- PostgreSQL with `pgvector` (for RAG)
- OpenAI GPT‑4o‑mini (intent classification, conversation management, RAG)
- In‑memory session store (upgradeable to Redis)

## Database Schema

See the `accommodations` and `gov_knowledge` tables above.

## API

`POST /ask` with `{ "question": "...", "sessionId": "...", "language": "en" }`

Responses include `answer` and `handoff_data` for WhatsApp.

## Deployment

Same as before: push to GitHub, deploy on Render, set environment variables.

## License

Proprietary – 24askme.com
