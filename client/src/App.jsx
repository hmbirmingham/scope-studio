import { useState } from 'react'
import './App.css'

function App() {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')

  function handleSubmit(event) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setDraft('')
  }

  return (
    <div className="chat-shell">
      <header className="chat-header">
        <h1>Scope Studio</h1>
      </header>

      <main className="chat-log">
        {messages.length === 0 && (
          <p className="chat-empty">Ask a question about your connected projects.</p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`chat-message chat-message--${message.role}`}>
            {message.text}
          </div>
        ))}
      </main>

      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask Scope Studio..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  )
}

export default App
