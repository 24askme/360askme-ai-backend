// server.js – Presidential Conversational AI for 24askme.com
// Supports: general Rwanda Q&A (RAG, conversational) and accommodation search (multi‑turn).
// Extensible to transport, jobs, government services, etc.

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Session store (in‑memory; replace with Redis for production)
const sessions = new Map();

// ---------- Helper: generate embedding for RAG ----------
async function getEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

// ---------- Helper: search government knowledge (RAG) ----------
async function searchGovKnowledge(query, limit = 5) {
  const queryEmbedding = await getEmbedding(query);
  const result = await pool.query(
    `SELECT content, source_url, title 
     FROM gov_knowledge 
     ORDER BY embedding <-> $1 
     LIMIT $2`,
    [JSON.stringify(queryEmbedding), limit]
  );
  return result.rows;
}

// ---------- Helper: search accommodations ----------
async function searchAccommodations(filters) {
  let sql = `SELECT * FROM accommodations WHERE 1=1`;
  const params = [];
  if (filters.area) {
    params.push(`%${filters.area}%`);
    sql += ` AND area ILIKE $${params.length}`;
  }
  if (filters.price_max) {
    params.push(filters.price_max);
    sql += ` AND price_per_night <= $${params.length}`;
  }
  if (filters.bedrooms) {
    params.push(filters.bedrooms);
    sql += ` AND bedrooms = $${params.length}`;
  }
  sql += ` LIMIT 5`;
  const result = await pool.query(sql, params);
  return result.rows;
}

// ---------- Intent classification (extensible) ----------
async function classifyIntent(question) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Classify the user's question into one of:
        - "general": anything about Rwanda that is not a specific service request (visa, taxes, safety, history, events, culture, cost of living, etc.)
        - "accommodation": looking for a house, apartment, hotel, guesthouse, Airbnb, or place to stay.
        Respond with JSON: { "intent": "general" or "accommodation" }` },
      { role: 'user', content: question }
    ],
    response_format: { type: 'json_object' }
  });
  const result = JSON.parse(completion.choices[0].message.content);
  return result.intent;
}

// ---------- Conversational RAG for general questions ----------
async function handleGeneralConversation(sessionId, question, state) {
  // If no state, initialise
  if (!state) {
    state = {
      intent: 'general',
      waitingFor: null,        // e.g., 'visa_type', 'tax_year', etc.
      clarificationNeeded: false,
      originalQuestion: question
    };
    sessions.set(sessionId, state);
  }

  // Use OpenAI to decide if we need clarification or can answer directly
  const systemPrompt = `You are 24mbaza AI for 24askme.com, a conversational assistant for Rwanda.
Current state: waitingFor = ${state.waitingFor}, original question = "${state.originalQuestion}".
User just said: "${question}"

Rules:
- If waitingFor is null, determine if the user's question is specific enough to answer directly.
- If it is vague (e.g., "tell me about visas"), set waitingFor to a clarifying field (e.g., "visa_type") and ask a follow‑up question.
- If waitingFor is set, extract the missing information from the user's answer, then set waitingFor = null and proceed to answer.
- When you have all necessary information, respond with action = "answer" and include the final answer.
- Always respond in JSON: { "action": "ask" or "answer", "message": "text", "updated_waitingFor": null or new value, "final_answer": "..." (if action=answer) }`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ],
    response_format: { type: 'json_object' }
  });
  const aiResponse = JSON.parse(completion.choices[0].message.content);

  if (aiResponse.action === 'ask') {
    // Update waitingFor and store in session
    state.waitingFor = aiResponse.updated_waitingFor;
    sessions.set(sessionId, state);
    return { answer: aiResponse.message, handoff_data: null };
  } else { // action === 'answer'
    // Now perform RAG with the fully clarified question
    const clarifiedQuestion = aiResponse.final_answer ? aiResponse.final_answer : state.originalQuestion;
    const docs = await searchGovKnowledge(clarifiedQuestion);
    const context = docs.map(d => d.content).join('\n\n');
    const ragCompletion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are 24mbaza AI for 24askme.com. Answer the user's question based ONLY on the following context from official government sources. If the context does not contain the answer, say "I don't have that information yet. Please ask our human concierge for help." Be warm, professional, and presidential‑level. End with a call to action to connect to a human if needed.` },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${clarifiedQuestion}` }
      ]
    });
    const answer = ragCompletion.choices[0].message.content;
    const handoffData = { type: 'general', question: clarifiedQuestion };
    // Clear session
    sessions.delete(sessionId);
    return { answer, handoff_data: handoffData };
  }
}

// ---------- Conversational accommodation search ----------
async function handleAccommodationConversation(sessionId, question, state) {
  if (!state) {
    state = {
      intent: 'accommodation',
      filters: {},
      waitingFor: 'budget',
      lastQuestion: null
    };
    sessions.set(sessionId, state);
  }

  const systemPrompt = `You are 24mbaza AI for 24askme.com, helping users find accommodation in Rwanda.
Current session: waitingFor = ${state.waitingFor}, filters = ${JSON.stringify(state.filters)}.
User just said: "${question}"

Rules:
- If waitingFor = "budget", extract a numeric budget (in USD or RWF, convert to USD). Store as price_max in filters. Then set waitingFor = "area".
- If waitingFor = "area", extract the area name (e.g., Kacyiru, Remera). Store as area. Then set waitingFor = "bedrooms".
- If waitingFor = "bedrooms", extract number of bedrooms (1,2,3). Store as bedrooms. Then set waitingFor = "done".
- When waitingFor = "done", do not ask more questions; respond with action = "search".
- Always respond in JSON: { "action": "ask" or "search", "message": "text for user", "updated_filters": {}, "waitingFor_next": "..." }`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ],
    response_format: { type: 'json_object' }
  });
  const aiResponse = JSON.parse(completion.choices[0].message.content);

  if (aiResponse.updated_filters) Object.assign(state.filters, aiResponse.updated_filters);
  if (aiResponse.waitingFor_next) state.waitingFor = aiResponse.waitingFor_next;

  if (aiResponse.action === 'search') {
    const results = await searchAccommodations(state.filters);
    let answerText = '';
    let handoffData = null;
    if (results.length === 0) {
      answerText = `I couldn't find any accommodation matching your criteria (budget up to ${state.filters.price_max || '?'} USD, area ${state.filters.area || 'any'}, ${state.filters.bedrooms || 'any'} bedrooms). Would you like to adjust your filters or speak to a human agent?`;
      handoffData = { type: 'accommodation', no_results: true, filters: state.filters };
    } else {
      answerText = `I found ${results.length} option(s):\n\n`;
      results.forEach((r, idx) => {
        answerText += `${idx+1}. **${r.name}** (${r.type})\n   Location: ${r.area}\n   Price: $${r.price_per_night}/night or $${r.price_per_month}/month\n   Bedrooms: ${r.bedrooms || 'N/A'}\n   Amenities: ${r.amenities?.join(', ') || 'N/A'}\n\n`;
      });
      answerText += `Would you like me to connect you to a real agent who can arrange viewings?`;
      handoffData = { type: 'accommodation', options: results.map(r => ({ id: r.id, name: r.name, price: r.price_per_night, area: r.area })) };
    }
    sessions.delete(sessionId);
    return { answer: answerText, handoff_data: handoffData };
  }

  // Otherwise, send the next question
  sessions.set(sessionId, state);
  return { answer: aiResponse.message, handoff_data: null };
}

// ---------- Main endpoint ----------
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId, language = 'en' } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    // Get existing session state (if any)
    let state = sessions.get(sessionId);

    // If no state, classify intent to start a new conversation
    if (!state) {
      const intent = await classifyIntent(question);
      if (intent === 'general') {
        const result = await handleGeneralConversation(sessionId, question, null);
        return res.json(result);
      } else if (intent === 'accommodation') {
        const result = await handleAccommodationConversation(sessionId, question, null);
        return res.json(result);
      } else {
        // Fallback
        return res.json({ answer: "I'm here to help with Rwanda-related questions or finding accommodation. Could you please rephrase?", handoff_data: null });
      }
    }

    // If state exists, continue the conversation based on intent
    if (state.intent === 'general') {
      const result = await handleGeneralConversation(sessionId, question, state);
      return res.json(result);
    } else if (state.intent === 'accommodation') {
      const result = await handleAccommodationConversation(sessionId, question, state);
      return res.json(result);
    } else {
      // Unknown intent – reset
      sessions.delete(sessionId);
      return res.json({ answer: "Let's start over. What do you need help with in Rwanda?", handoff_data: null });
    }

  } catch (error) {
    console.error('Error in /ask:', error);
    res.status(500).json({ error: 'Internal server error. Please try again later.' });
  }
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 24askme.com Presidential AI running on port ${PORT}`));