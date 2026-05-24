let socket;
let token;
let currentUser;
let selectedContact = null;

const app = document.getElementById('app');

function showLogin() {
  app.innerHTML = `
    <div class="login-box">
      <h2>Termux Messenger</h2>
      <input id="username" placeholder="Username" />
      <input id="password" type="password" placeholder="Password" />
      <button onclick="signup()">Sign Up</button>
      <button onclick="login()">Log In</button>
      <p id="error" style="color:red"></p>
    </div>
  `;
}

async function signup() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) return;
  const res = await fetch('/signup', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({username, password})
  });
  const data = await res.json();
  if (data.error) document.getElementById('error').innerText = data.error;
  else alert('Signup successful! Please log in.');
}

async function login() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) return;
  const res = await fetch('/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({username, password})
  });
  const data = await res.json();
  if (data.error) document.getElementById('error').innerText = data.error;
  else {
    token = data.token;
    currentUser = { id: data.id, username: data.username };
    localStorage.setItem('token', token);
    connectSocket();
    showMainUI();
  }
}

function connectSocket() {
  socket = io();
  socket.emit('join', token);
  socket.on('private message', (msg) => {
    if (selectedContact && 
        (msg.sender === selectedContact.id || msg.sender === currentUser.id)) {
      addMessageToChat(msg);
    }
  });
}

function showMainUI() {
  app.innerHTML = `
    <div class="sidebar">
      <div class="header">Chats</div>
      <div class="add-contact-area">
        <input id="newContact" placeholder="Add username" />
        <button onclick="addContact()">+</button>
      </div>
      <div class="contact-list" id="contactList"></div>
    </div>
    <div class="chat-area">
      <div class="header" id="chatHeader">Select a contact</div>
      <div class="messages" id="messages"></div>
      <div class="input-area">
        <input id="msgInput" placeholder="Message" />
        <button onclick="sendMessage()">Send</button>
      </div>
    </div>
  `;
  loadContacts();
}

async function loadContacts() {
  const res = await fetch('/contacts', {
    headers: {'Authorization': `Bearer ${token}`}
  });
  const contacts = await res.json();
  const list = document.getElementById('contactList');
  if (contacts.length === 0) {
    list.innerHTML = '<div style="padding:10px">No contacts yet</div>';
    return;
  }
  list.innerHTML = contacts.map(c => `
    <div class="contact" onclick="openChat(${c.id}, '${c.username}')">${c.username}</div>
  `).join('');
}

async function addContact() {
  const username = document.getElementById('newContact').value.trim();
  if (!username) return;
  const res = await fetch('/add-contact', {
    method:'POST',
    headers: {
      'Content-Type':'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ contactUsername: username })
  });
  const data = await res.json();
  if (data.error) alert(data.error);
  else {
    document.getElementById('newContact').value = '';
    loadContacts();
  }
}

async function openChat(contactId, contactName) {
  selectedContact = { id: contactId, name: contactName };
  document.getElementById('chatHeader').innerText = contactName;
  document.getElementById('messages').innerHTML = '';
  const res = await fetch(`/messages/${contactId}`, {
    headers: {'Authorization': `Bearer ${token}`}
  });
  const msgs = await res.json();
  msgs.forEach(addMessageToChat);
}

function addMessageToChat(msg) {
  const messagesDiv = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + (msg.sender === currentUser.id ? 'sent' : 'received');
  div.innerText = msg.text;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (text && selectedContact) {
    socket.emit('private message', { to: selectedContact.id, text });
    input.value = '';
  }
}

if (localStorage.getItem('token')) {
  token = localStorage.getItem('token');
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    currentUser = { id: payload.id, username: payload.username };
    connectSocket();
    showMainUI();
  } catch (e) {
    localStorage.removeItem('token');
    showLogin();
  }
} else {
  showLogin();
}
