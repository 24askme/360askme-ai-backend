// server.js – Corrected Accommodation Flow with Area Preservation
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

const sessions = new Map();

// Extract information from user message
function extractInfo(message) {
  const msg = message.toLowerCase();
  const info = { area: null, type: null, budget: null, bedrooms: null };
  
  // Areas (Kigali + secondary cities)
  const areas = ['kacyiru', 'kiyovu', 'remera', 'nyarutarama', 'kimihurura', 'muhanga', 'rubavu', 'huye', 'musanze', 'rwamagana', 'kayonza', 'nyagatare', 'gicumbi', 'bugesera'];
  for (const area of areas) {
    if (msg.includes(area)) {
      info.area = area.charAt(0).toUpperCase() + area.slice(1);
      break;
    }
  }
  
  // Types
  if (msg.includes('hotel')) info.type = 'hotel';
  else if (msg.includes('guesthouse')) info.type = 'guesthouse';
  else if (msg.includes('apartment')) info.type = 'apartment';
  else if (msg.includes('house')) info.type = 'house';
  
  // Budget (numbers)
  const budgetMatch = msg.match(/\$?(\d+)/);
  if (budgetMatch) info.budget = parseInt(budgetMatch[1]);
  
  // Bedrooms
  const bedroomMatch = msg.match(/(\d+)\s*bedroom/);
  if (bedroomMatch) info.bedrooms = parseInt(bedroomMatch[1]);
  
  return info;
}

// Search accommodations
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
  if (filters.type) {
    params.push(filters.type);
    sql += ` AND type = $${params.length}`;
  }
  if (filters.bedrooms) {
    params.push(filters.bedrooms);
    sql += ` AND bedrooms = $${params.length}`;
  }
  sql += ` LIMIT 5`;
  
  const result = await pool.query(sql, params);
  return result.rows;
}

// Main endpoint
app.post('/ask', async (req, res) => {
  try {
    const { question, sessionId } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    let state = sessions.get(sessionId);
    const extracted = extractInfo(question);
    
    // Initialize session if new
    if (!state) {
      state = { 
        step: 'start', 
        filters: {}, 
        awaiting: null,
        lastResults: null
      };
      sessions.set(sessionId, state);
    }
    
    // Merge extracted info into filters
    if (extracted.area && !state.filters.area) state.filters.area = extracted.area;
    if (extracted.type && !state.filters.type) state.filters.type = extracted.type;
    if (extracted.budget && !state.filters.price_max) state.filters.price_max = extracted.budget;
    if (extracted.bedrooms && !state.filters.bedrooms) state.filters.bedrooms = extracted.bedrooms;
    
    // Check if user is confirming handoff
    const yesResponse = question.toLowerCase().trim() === 'yes' || 
                        question.toLowerCase().trim() === 'yeah' || 
                        question.toLowerCase().trim() === 'sure' ||
                        question.toLowerCase().trim() === 'ok' ||
                        question.toLowerCase().trim() === 'okay';
    
    if (state.step === 'waiting_for_confirmation' && yesResponse) {
      sessions.delete(sessionId);
      return res.json({ 
        answer: "Excellent! I'm connecting you to a human concierge right now. They will contact you via WhatsApp within a few minutes to complete your booking. Thank you for choosing 360ASKME.",
        handoff_data: { type: 'accommodation', action: 'handoff', options: state.lastResults }
      });
    }
    
    // Check if user wants accommodation
    const isAccommodation = question.toLowerCase().includes('house') || 
                            question.toLowerCase().includes('apartment') || 
                            question.toLowerCase().includes('hotel') || 
                            question.toLowerCase().includes('guesthouse') || 
                            question.toLowerCase().includes('place to stay') ||
                            question.toLowerCase().includes('accommodation') ||
                            question.toLowerCase().includes('room') ||
                            question.toLowerCase().includes('lodge');
    
    if (isAccommodation || state.step !== 'start') {
      
      // Determine what information we still need
      const missing = [];
      if (!state.filters.price_max) missing.push('budget');
      if (!state.filters.area) missing.push('area');
      if (!state.filters.bedrooms && state.filters.type !== 'hotel') missing.push('bedrooms');
      
      // If we have all info, search immediately
      if (missing.length === 0) {
        const results = await searchAccommodations(state.filters);
        sessions.delete(sessionId);
        
        if (results.length === 0) {
          return res.json({ answer: `I couldn't find any ${state.filters.type || 'accommodation'} matching your criteria (budget: $${state.filters.price_max}, area: ${state.filters.area}). Would you like to adjust your search or speak to a human concierge?`, handoff_data: null });
        }
        
        let answerText = `I found ${results.length} option(s) for you:\n\n`;
        results.forEach((r, idx) => {
          answerText += `${idx+1}. **${r.name}** (${r.type})\n   Location: ${r.area}\n   Price: $${r.price_per_night}/night\n   Rating: ${r.rating || 'N/A'}\n`;
          if (r.amenities) answerText += `   Amenities: ${r.amenities.join(', ')}\n`;
          answerText += `\n`;
        });
        answerText += `Would you like me to connect you to a human concierge to book this for you? Please reply "yes" or "no".`;
        
        const newState = { step: 'waiting_for_confirmation', filters: state.filters, lastResults: results };
        sessions.set(sessionId, newState);
        
        return res.json({ answer: answerText, handoff_data: null });
      }
      
      // Ask for the next missing piece
      if (missing.includes('budget')) {
        state.step = 'asking_budget';
        sessions.set(sessionId, state);
        let typeMsg = state.filters.type ? state.filters.type + ' ' : '';
        let areaMsg = state.filters.area ? ` in ${state.filters.area}` : '';
        return res.json({ answer: `What is your budget in USD for this ${typeMsg}accommodation${areaMsg}?`, handoff_data: null });
      }
      
      if (missing.includes('area')) {
        state.step = 'asking_area';
        sessions.set(sessionId, state);
        return res.json({ answer: `Which area do you prefer? (e.g., Kacyiru, Kiyovu, Remera, Muhanga, Rubavu, Huye, Musanze)`, handoff_data: null });
      }
      
      if (missing.includes('bedrooms')) {
        state.step = 'asking_bedrooms';
        sessions.set(sessionId, state);
        return res.json({ answer: `How many bedrooms do you need?`, handoff_data: null });
      }
    }
    
    // For general questions (not accommodation)
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are 360ASKME AI, the presidential concierge for Rwanda. Answer questions about visas, business, cost of living, tourism, and culture. Be warm and professional. Always offer to connect to a human concierge.` },
        { role: 'user', content: question }
      ]
    });
    
    return res.json({ answer: completion.choices[0].message.content, handoff_data: null });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 360ASKME AI running on port ${PORT}`));
