const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'MFL CORS Proxy is running' });
});

// MFL API proxy endpoint
// Usage: /api/mfl/:type/:id
// Example: /api/mfl/rosters/26696
app.get('/api/mfl/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    
    // Validate inputs
    if (!type || !id) {
      return res.status(400).json({ error: 'Missing type or id parameter' });
    }
    
    // Build the MFL API URL
    const mflUrl = `https://api.myfantasyleague.com/2026/export?TYPE=${encodeURIComponent(type)}&L=${encodeURIComponent(id)}&JSON=1`;
    
    console.log(`Fetching: ${mflUrl}`);
    
    // Fetch from MFL API
    const response = await fetch(mflUrl, {
      headers: {
        'User-Agent': 'myffl-proxy/1.0'
      }
    });
    
    if (!response.ok) {
      console.error(`MFL API error: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ 
        error: `MFL API returned ${response.status}`,
        statusText: response.statusText
      });
    }
    
    // Parse and return JSON
    const data = await response.json();
    res.json(data);
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch from MFL API',
      message: error.message
    });
  }
});

// Generic proxy endpoint for any MFL export request
// Usage: /api/proxy?type=rosters&L=26696
app.get('/api/proxy', async (req, res) => {
  try {
    const { type, L } = req.query;
    
    if (!type || !L) {
      return res.status(400).json({ error: 'Missing type or L query parameter' });
    }
    
    const mflUrl = `https://api.myfantasyleague.com/2026/export?TYPE=${encodeURIComponent(type)}&L=${encodeURIComponent(L)}&JSON=1`;
    
    console.log(`Fetching: ${mflUrl}`);
    
    const response = await fetch(mflUrl, {
      headers: {
        'User-Agent': 'myffl-proxy/1.0'
      }
    });
    
    if (!response.ok) {
      console.error(`MFL API error: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ 
        error: `MFL API returned ${response.status}`,
        statusText: response.statusText
      });
    }
    
    const data = await response.json();
    res.json(data);
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch from MFL API',
      message: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`MFL CORS Proxy server running on port ${PORT}`);
});
