const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Persistent database on Render’s mounted disk
const db = new Database('/opt/render/project/data/chat.db');
db.pragma('journal_mode = WAL');

// Create tables if they don’t exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER,
    contact_id INTEGER,
    PRIMARY KEY(user_id, contact_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender INTEGER NOT NULL,
    receiver INTEGER NOT NULL,
    text TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const PORT = process.env.PORT || 3000;

// Serve static files (our frontend)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- REST API ----------
app.post('/signup', (req, res) => {
  const { username, password } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Username taken' });
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ token, id: user.id, username: user.username });
});

app.get('/contacts', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const contacts = db.prepare(`
      SELECT u.id, u.username FROM contacts c
      JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = ?
    `).all(id);
    res.json(contacts);
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
});

app.post('/add-contact', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { contactUsername } = req.body;
    const contact = db.prepare('SELECT id FROM users WHERE username = ?').get(contactUsername);
    if (!contact) return res.status(404).json({ error: 'User not found' });
    db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)').run(id, contact.id);
    res.json({ success: true, contactId: contact.id });
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
});

app.get('/messages/:contactId', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const msgs = db.prepare(`
      SELECT * FROM messages
      WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
      ORDER BY timestamp
    `).all(id, req.params.contactId, req.params.contactId, id);
    res.json(msgs);
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
});

// ---------- Socket.io real‑time messaging ----------
io.on('connection', (socket) => {
  console.log('User connected');
  socket.on('join', (token) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      socket.userId = user.id;
      socket.username = user.username;
      socket.join(`user_${user.id}`);   // private room for this user
    } catch { socket.disconnect(); }
  });

  socket.on('private message', ({ to, text }) => {
    if (!socket.userId) return;
    const info = db.prepare('INSERT INTO messages (sender, receiver, text) VALUES (?, ?, ?)').run(socket.userId, to, text);
    const payload = {
      id: info.lastInsertRowid,
      sender: socket.userId,
      senderName: socket.username,
      text,
      timestamp: new Date().toISOString()
    };
    // Send to receiver and also back to sender (so it appears in their chat)
    io.to(`user_${to}`).emit('private message', payload);
    socket.emit('private message', payload);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));