/**
 * ════════════════════════════════════════════════════════════════════════
 *  ai-chat-widget.js
 * ────────────────────────────────────────────────────────────────────────
 *  Shared, reusable AI chat engine for InvestySignals.
 *
 *  Used by BOTH:
 *    • the "💬 Chat about this Trade" side panel (analysis.html / live-signals.html)
 *    • the full-page "/ask-ai" Global AI Chat
 *
 *  Provides:
 *    1. AIChat.streamChat(...)   — low-level POST+SSE consumer (EventSource
 *                                   can't POST, so we parse SSE frames out
 *                                   of a fetch() ReadableStream by hand)
 *    2. AIChat.mount(el, opts)   — a complete, drop-in chat UI: message
 *                                   list, status pill, input box, send
 *                                   button, auto-scroll, markdown rendering
 *
 *  Depends on marked.js + DOMPurify being loaded on the host page (both via
 *  cdnjs — see the <script> tags added to ask-ai.html / analysis.html).
 *  Both are loaded with graceful fallbacks below, so a CDN hiccup can never
 *  crash the chat — it just falls back to plain text.
 * ════════════════════════════════════════════════════════════════════════
 */
(function (global) {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // Markdown rendering — beautiful signal/answer formatting, sanitized
  // ──────────────────────────────────────────────────────────────────
  function renderMarkdown(text) {
    const safeText = text || '';
    try {
      if (global.marked && global.DOMPurify) {
        const raw = global.marked.parse(safeText, { breaks: true });
        return global.DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
      }
    } catch (_) {
      /* fall through to plain-text escape below */
    }
    const div = document.createElement('div');
    div.textContent = safeText;
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  function escapeText(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // ──────────────────────────────────────────────────────────────────
  // Low-level SSE-over-POST consumer
  // ──────────────────────────────────────────────────────────────────
  async function streamChat({ endpoint, body, getToken, onStatus, onToken, onToolDone, onError, onDone }) {
    let headers = { 'Content-Type': 'application/json' };
    try {
      const token = getToken ? await getToken() : null;
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch (_) {
      /* no auth available — let the server decide whether that's fatal */
    }

    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (_networkErr) {
      onError && onError('Could not reach the server — check your connection and try again.');
      onDone && onDone();
      return;
    }

    if (!res.ok || !res.body) {
      let msg = res.status === 429 ? 'You are sending messages too quickly — please slow down a little.' : 'The AI service is unavailable right now.';
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {
        /* not JSON — keep default message */
      }
      onError && onError(msg);
      onDone && onDone();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let frameEnd;
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          let eventType = 'message';
          let dataLine = '';
          frame.split('\n').forEach((line) => {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLine += line.slice(6);
          });
          if (!dataLine) continue;
          let data;
          try {
            data = JSON.parse(dataLine);
          } catch (_) {
            continue;
          }
          if (eventType === 'status') onStatus && onStatus(data.label);
          else if (eventType === 'token') onToken && onToken(data.text);
          else if (eventType === 'tool_done') onToolDone && onToolDone(data.tool);
          else if (eventType === 'error') onError && onError(data.message);
        }
      }
    } catch (_readErr) {
      onError && onError('Connection lost while streaming the response.');
    }
    onDone && onDone();
  }

  // ──────────────────────────────────────────────────────────────────
  // Injected styles (once) — keeps both host pages visually consistent
  // with the existing dark/gold InvestySignals design tokens, with zero
  // CSS duplication needed in the host HTML files.
  // ──────────────────────────────────────────────────────────────────
  function injectStylesOnce() {
    if (document.getElementById('ai-chat-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-chat-widget-styles';
    style.textContent = `
.aic-root{display:flex;flex-direction:column;height:100%;font-family:'Space Grotesk',sans-serif;}
.aic-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px;scroll-behavior:smooth;}
.aic-messages::-webkit-scrollbar{width:6px;}
.aic-messages::-webkit-scrollbar-thumb{background:var(--border-soft,#2a2a2e);border-radius:3px;}
.aic-bubble{max-width:92%;padding:11px 14px;border-radius:14px;font-size:0.88rem;line-height:1.5;word-wrap:break-word;}
.aic-bubble.user{align-self:flex-end;background:linear-gradient(135deg,rgba(240,180,41,0.16),rgba(240,180,41,0.06));border:1px solid rgba(240,180,41,0.3);color:var(--text,#eee);border-bottom-right-radius:4px;}
.aic-bubble.assistant{align-self:flex-start;background:var(--surface,#191920);border:1px solid var(--border-soft,#2a2a2e);color:var(--text,#eee);border-bottom-left-radius:4px;}
.aic-bubble.error{align-self:center;background:rgba(255,77,79,0.1);border:1px solid rgba(255,77,79,0.35);color:#ff8a8a;font-size:0.8rem;}
.aic-bubble p{margin:0 0 8px;}
.aic-bubble p:last-child{margin-bottom:0;}
.aic-bubble ul,.aic-bubble ol{margin:4px 0 8px;padding-left:20px;}
.aic-bubble li{margin-bottom:3px;}
.aic-bubble strong{color:var(--gold,#f0b429);}
.aic-bubble code{background:rgba(255,255,255,0.07);padding:1px 5px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:0.82em;}
.aic-bubble a{color:var(--blue,#3b8bff);text-decoration:underline;}
.aic-status{align-self:flex-start;display:flex;align-items:center;gap:8px;padding:8px 13px;border-radius:12px;background:var(--surface,#191920);border:1px solid var(--border-soft,#2a2a2e);color:var(--text-muted,#9a9aa2);font-size:0.78rem;font-family:'JetBrains Mono',monospace;}
.aic-dots{display:flex;gap:3px;}
.aic-dots span{width:5px;height:5px;border-radius:50%;background:var(--gold,#f0b429);animation:aicPulse 1.2s infinite ease-in-out;}
.aic-dots span:nth-child(2){animation-delay:0.15s;}
.aic-dots span:nth-child(3){animation-delay:0.3s;}
@keyframes aicPulse{0%,80%,100%{opacity:0.25;transform:scale(0.8);}40%{opacity:1;transform:scale(1);}}
.aic-empty{align-self:center;text-align:center;color:var(--text-dim,#666);font-size:0.82rem;padding:30px 16px;max-width:80%;}
.aic-inputrow{display:flex;gap:8px;padding:12px;border-top:1px solid var(--border-soft,#2a2a2e);background:var(--bg2,#13131a);}
.aic-input{flex:1;resize:none;background:var(--surface,#191920);border:1px solid var(--border-soft,#2a2a2e);color:var(--text,#eee);padding:10px 12px;border-radius:10px;outline:none;font-family:'Space Grotesk',sans-serif;font-size:0.88rem;max-height:120px;line-height:1.4;}
.aic-input:focus{border-color:var(--gold,#f0b429);box-shadow:0 0 0 3px var(--gold-subtle,rgba(240,180,41,0.12));}
.aic-send{width:42px;height:42px;flex-shrink:0;border-radius:10px;border:1px solid rgba(240,180,41,0.4);background:linear-gradient(135deg,rgba(240,180,41,0.18),rgba(240,180,41,0.05));color:var(--gold,#f0b429);font-size:1.05rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:0.15s;}
.aic-send:hover:not(:disabled){box-shadow:0 0 14px rgba(240,180,41,0.2);}
.aic-send:disabled{opacity:0.4;cursor:not-allowed;}
.aic-suggestions{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px;}
.aic-suggestion{padding:6px 11px;border-radius:20px;border:1px solid var(--border-soft,#2a2a2e);background:var(--surface,#191920);color:var(--text-muted,#9a9aa2);font-size:0.74rem;cursor:pointer;transition:0.15s;font-family:'Space Grotesk',sans-serif;}
.aic-suggestion:hover{border-color:var(--gold,#f0b429);color:var(--gold,#f0b429);}
`;
    document.head.appendChild(style);
  }

  // ──────────────────────────────────────────────────────────────────
  // High-level UI controller — mounts a full chat experience into `el`
  // ──────────────────────────────────────────────────────────────────
  function mount(el, opts) {
    injectStylesOnce();
    const {
      endpoint,
      getToken,
      getReportContext, // () => object|null — only used by Trade Copilot
      welcomeText = "Ask me anything about this market — I'll pull real data before I answer.",
      placeholder = 'Ask a question…',
      suggestions = [],
    } = opts || {};

    el.classList.add('aic-root');
    el.innerHTML = `
      <div class="aic-messages" id="aicMessages">
        <div class="aic-empty">${escapeText(welcomeText)}</div>
      </div>
      ${suggestions.length ? `<div class="aic-suggestions">${suggestions.map((s) => `<button class="aic-suggestion" type="button">${escapeText(s)}</button>`).join('')}</div>` : ''}
      <div class="aic-inputrow">
        <textarea class="aic-input" id="aicInput" rows="1" placeholder="${escapeText(placeholder)}"></textarea>
        <button class="aic-send" id="aicSend" type="button" aria-label="Send">➤</button>
      </div>
    `;

    const messagesEl = el.querySelector('#aicMessages');
    const inputEl = el.querySelector('#aicInput');
    const sendBtn = el.querySelector('#aicSend');
    const history = []; // [{role:'user'|'assistant', content:string}]
    let busy = false;

    function clearEmptyState() {
      const empty = messagesEl.querySelector('.aic-empty');
      if (empty) empty.remove();
    }

    function isNearBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
    }

    function autoScroll(forceNear) {
      if (forceNear || isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addBubble(role, html) {
      clearEmptyState();
      const wasNear = isNearBottom();
      const bubble = document.createElement('div');
      bubble.className = 'aic-bubble ' + role;
      bubble.innerHTML = html;
      messagesEl.appendChild(bubble);
      autoScroll(wasNear || role === 'user');
      return bubble;
    }

    function addStatus(label) {
      removeStatus();
      const wasNear = isNearBottom();
      const status = document.createElement('div');
      status.className = 'aic-status';
      status.id = 'aicStatusPill';
      status.innerHTML = `<span>${escapeText(label)}</span><span class="aic-dots"><span></span><span></span><span></span></span>`;
      messagesEl.appendChild(status);
      autoScroll(wasNear);
    }

    function removeStatus() {
      const existing = messagesEl.querySelector('#aicStatusPill');
      if (existing) existing.remove();
    }

    function setBusy(state) {
      busy = state;
      sendBtn.disabled = state;
      inputEl.disabled = state;
    }

    async function send(text) {
      const trimmed = (text || '').trim();
      if (!trimmed || busy) return;
      setBusy(true);
      addBubble('user', escapeText(trimmed));
      inputEl.value = '';
      inputEl.style.height = 'auto';

      // Live "typing" bubble — raw text node while streaming (fast, safe),
      // upgraded to fully-rendered sanitized markdown once the turn ends.
      const wasNear = isNearBottom();
      clearEmptyState();
      const liveBubble = document.createElement('div');
      liveBubble.className = 'aic-bubble assistant';
      const rawSpan = document.createElement('span');
      liveBubble.appendChild(rawSpan);
      messagesEl.appendChild(liveBubble);
      autoScroll(wasNear);

      let rawText = '';
      let gotAnyToken = false;

      await streamChat({
        endpoint,
        body: {
          message: trimmed,
          history,
          reportContext: getReportContext ? getReportContext() : undefined,
        },
        getToken,
        onStatus: (label) => addStatus(label),
        onToken: (text) => {
          if (!gotAnyToken) {
            removeStatus();
            gotAnyToken = true;
          }
          rawText += text;
          rawSpan.textContent = rawText;
          autoScroll(true);
        },
        onToolDone: () => {
          /* status pill is replaced by the next status / cleared on first token */
        },
        onError: (message) => {
          removeStatus();
          addBubble('error', '⚠️ ' + escapeText(message));
        },
        onDone: () => {
          removeStatus();
          if (rawText) {
            liveBubble.innerHTML = renderMarkdown(rawText);
            history.push({ role: 'user', content: trimmed });
            history.push({ role: 'assistant', content: rawText });
          } else if (!liveBubble.parentNode) {
            /* error already shown its own bubble */
          } else if (!gotAnyToken) {
            liveBubble.remove(); // pure error turn — nothing to show here
          }
          autoScroll(true);
          setBusy(false);
          inputEl.focus();
        },
      });
    }

    sendBtn.addEventListener('click', () => send(inputEl.value));
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(inputEl.value);
      }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });
    el.querySelectorAll('.aic-suggestion').forEach((btn) => {
      btn.addEventListener('click', () => send(btn.textContent));
    });

    return {
      sendProgrammatic: (text) => send(text),
      focus: () => inputEl.focus(),
      getHistory: () => history.slice(),
    };
  }

  global.AIChat = { streamChat, renderMarkdown, mount };
})(window);
