import { useState, useRef, useCallback, useEffect } from 'react';
import { MathUtils } from 'three';


/* ---------------------------------------------------------------------------
   Client / Server protocol
--------------------------------------------------------------------------- */
const CLIENT_MSG = { END: 'end', AGENT_FINISHED_SPEAKING: 'agent_finished_speaking', START_MIC_STREAM: "start_mic_stream" }; // binary MIC_CHUNK is implied when sending ArrayBuffer
const SERVER_MSG = {
  TRANSCRIPT:    'transcript',     // final STT result
  ASSISTANT_TEXT:'assistant_text', // assistant reply (may stream in parts)
  AUDIO_END:     'audio_end',      // all TTS chunks sent
  // TTS_AUDIO_CHUNK – implicit binary frames
};


export default function useVoiceChatWSv2(
  userVisualizerRef,
  apiBase = import.meta.env.VITE_API_BASE || 'https://ai-therapist.crafzen.com'
) {
  /* ============================= React state ============================== */
  const [chatHistory, setChatHistory] = useState([
    { role: 'assistant', content: "Hello, I'm here to listen. How can I assist you today?" },
  ]);
  const [status, setStatus]       = useState('idle');   // idle | listening | transcribing | speaking
  const [isChatting, setChatting] = useState(false);

  /* ========================= Persistent references ======================== */
  // Network + session
  const wsRef         = useRef(null);
  const sessionIdRef  = useRef(generateSessionId());

  // Mic & recording
  const micStreamRef  = useRef(null);
  const mediaRecRef   = useRef(null);
  const lastSendRef   = useRef(0);
  const userSpokeRef  = useRef(false);

  // Audio playback (TTS)
  const audioRef         = useRef(null);
  const mediaSourceRef   = useRef(null);
  const sourceBufferRef  = useRef(null);
  const chunkQueueRef    = useRef([]);       // Uint8Array[] awaiting append
  const fallbackChunks   = useRef([]);       // binary[] for blob fallback

  // Visualisation helpers
  const analyserRAF      = useRef(null);

  // Lifecycle flag
  const activeRef        = useRef(false);

  /* ========================== Helper functions ============================ */
  const appendMessage = (role, text) => setChatHistory(h => [...h, { role, content: text }]);

  const sendBinary = (buf)        => wsRef.current?.readyState === 1 && wsRef.current.send(buf);
  const sendJSON   = (obj)        => wsRef.current?.readyState === 1 && wsRef.current.send(JSON.stringify(obj));

  const updateVisualizer = (level) => {
    if (!userVisualizerRef?.current) return;
    const mesh = userVisualizerRef.current;
    const mat  = mesh.material;
    const target = MathUtils.clamp(level / 40, 0.1, 1.2);
    mat.uniforms.u_intensity.value = MathUtils.lerp(mat.uniforms.u_intensity.value, target, 0.1);
    const s = 0.8 + mat.uniforms.u_intensity.value * 0.4;
    mesh.scale.set(s, s, s);
  };

  /* ----------------------------- Mic + VAD ------------------------------ */
  const startMicRecording = useCallback(async () => {
    setStatus('listening');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;

    const mediaRec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecRef.current = mediaRec;
    mediaRec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const now = Date.now();
      if (now - lastSendRef.current >= 200) { // 200-ms throttle ≈5 fps
        sendBinary(e.data);
        lastSendRef.current = now;
      }
    };
    mediaRec.start(400);

    // --- Simple energy-based VAD ---
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    src.connect(analyser);

    let spoken = false;
    let silenceAt = Date.now();

    const VAD_LOOP = () => {
      if (mediaRec.state !== 'recording') return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      updateVisualizer(avg);

      if (avg >= 10) {
        spoken = true;
        userSpokeRef.current = true;
        silenceAt = Date.now();
      } else if (spoken && Date.now() - silenceAt > 1500) {
        // 1.5 s silence → flush pending data, then close container & signal END.
        const flushAndStop = () => {
          mediaRec.removeEventListener('dataavailable', flushAndStop);
          try { mediaRec.stop(); } catch {/* ignored */}
          // END marker will be sent in mediaRec.onstop to guarantee final chunk arrived.
        };

        // Force immediate dataavailable so we have the closing WebM bytes.
        try {
          mediaRec.addEventListener('dataavailable', flushAndStop, { once: true });
          mediaRec.requestData();
        } catch {
          // Fallback: if requestData unsupported, stop immediately.
          flushAndStop();
        }
        return;
      }
      analyserRAF.current = requestAnimationFrame(VAD_LOOP);
    };
    VAD_LOOP();

    mediaRec.onstop = () => {
      // All chunks are guaranteed to have been emitted at this point.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        sendJSON({ type: CLIENT_MSG.END });
      }
      // Update UI – waiting for STT → GPT.
      setStatus('transcribing');
      userSpokeRef.current = false;

      stream.getTracks().forEach(t => t.stop());
      cancelAnimationFrame(analyserRAF.current);
    };
  }, [userVisualizerRef]);

  /* --------------------------- MediaSource helpers ----------------------- */
  const pumpQueue = () => {
    if (!sourceBufferRef.current || sourceBufferRef.current.updating || !chunkQueueRef.current.length) return;
    sourceBufferRef.current.appendBuffer(chunkQueueRef.current.shift());
  };

  const ensureMSE = () => {
    if (mediaSourceRef.current || !('MediaSource' in window) || !MediaSource.isTypeSupported('audio/mpeg')) return;
    mediaSourceRef.current = new MediaSource();
    const ms = mediaSourceRef.current;
    const url = URL.createObjectURL(ms);
    const audio = new Audio(url);
    audioRef.current = audio;

    // Using MSE path – clear fallback buffer to avoid double playback.
    fallbackChunks.current = [];

    ms.addEventListener('sourceopen', () => {
      sourceBufferRef.current = ms.addSourceBuffer('audio/mpeg');
      sourceBufferRef.current.addEventListener('updateend', pumpQueue);
      pumpQueue();
    }, { once: true });

    audio.onended = () => {
      // Notify backend the client finished listening to TTS, then resume mic.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // sendJSON({ type: CLIENT_MSG.AGENT_FINISHED_SPEAKING });
      }
      if (activeRef.current) {
        // Delay restart slightly to avoid capturing residual speaker audio.
        setTimeout(() => {
          if (!activeRef.current) return;
          setStatus('listening');
          startMicRecording();
        }, 400); // 400 ms buffer
      }
    };
    audio.onerror = audio.onended;
    audio.play().catch(() => {});
  };

  const finishTTSPlayback = () => {
    const ms = mediaSourceRef.current;
    const sb = sourceBufferRef.current;

    const cleanupAndFallback = () => {
      mediaSourceRef.current = null;
      sourceBufferRef.current = null;
      chunkQueueRef.current = [];

      // Handle blob fallback if needed
      if (fallbackChunks.current.length) {
        const blob = new Blob(fallbackChunks.current, { type: 'audio/mpeg' });
        fallbackChunks.current = [];
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (activeRef.current) {
            setTimeout(() => {
              if (!activeRef.current) return;
              setStatus('listening');
              startMicRecording();
            }, 400);
          }
        };
        audio.onerror = audio.onended;
        audio.play().catch(() => {});
      }
    };

    // Only proceed if MediaSource is open
    if (ms?.readyState === 'open') {
      const endStream = () => {
        try {
          ms.endOfStream();
        } catch (err) {
          console.warn('MediaSource endOfStream failed:', err);
        }
        cleanupAndFallback();
      };

      if (sb?.updating) {
        // Wait for any ongoing updates and queued buffers
        const checkAndEnd = () => {
          if (chunkQueueRef.current.length > 0) {
            // More chunks queued, wait for next updateend
            return;
          }
          if (!sb.updating) {
            sb.removeEventListener('updateend', checkAndEnd);
            endStream();
          }
        };
        sb.addEventListener('updateend', checkAndEnd);
      } else {
        endStream();
      }
    } else {
      cleanupAndFallback();
    }
  };

  /* -------------------------- WebSocket lifecycle ----------------------- */
  const openSocket = useCallback(() => {
    const wsUrl = apiBase + `/ws/chat?session_id=${sessionIdRef.current}`;
    console.log("Connecting to WS at", wsUrl);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = startMicRecording;

    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(evt.data);
        chunkQueueRef.current.push(chunk);
        console.log(chunkQueueRef.current, chunk)
        if (!mediaSourceRef.current) {
          // Blob fallback buffer (only when MSE not in use)
          fallbackChunks.current.push(evt.data);
        }
        ensureMSE();
        pumpQueue();                // needed to start next append
        return;
      }
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === SERVER_MSG.TRANSCRIPT) {
        appendMessage('user', msg.text);
        // STT done; waiting for assistant reply.
        setStatus('transcribing');
      }
      else if (msg.type === SERVER_MSG.ASSISTANT_TEXT) {
        // Streamed assistant tokens: if partial, merge into last assistant bubble.
        setStatus('speaking');
        setChatHistory(prev => {
          const history = [...prev];
          const isAssistantLast = history.length && history[history.length - 1].role === 'assistant';

          if (msg.partial) {
            if (isAssistantLast) {
              // Append token delta to existing assistant message.
              history[history.length - 1] = {
                role: 'assistant',
                content: history[history.length - 1].content + msg.text,
              };
            } else {
              // First token – create new assistant bubble.
              history.push({ role: 'assistant', content: msg.text });
            }
          } else {
            // Final full message – ensure bubble has complete content (replace if needed)
            if (isAssistantLast) {
              history[history.length - 1] = { role: 'assistant', content: msg.text };
            } else {
              history.push({ role: 'assistant', content: msg.text });
            }
          }
          return history;
        });
      }
      else if (msg.type === SERVER_MSG.AUDIO_END)    finishTTSPlayback();
    };

    ws.onclose = () => setChatting(false);
    ws.onerror = ws.onclose;
  }, [apiBase, startMicRecording]);

  /* ----------------------------- Public API ----------------------------- */
  const startChat = () => {
    if (isChatting) return;
    activeRef.current = true;
    setChatting(true);
    if (userVisualizerRef?.current?.material?.uniforms) {
      userVisualizerRef.current.material.uniforms.u_intensity.value = 0.3;
      userVisualizerRef.current.scale.set(0.8, 0.8, 0.8);
    }
    openSocket();
  };

  const stopChat = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setChatting(false);
    wsRef.current?.close();
    // cleanup audio + mic
    try { micStreamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignored */ }
    try { audioRef.current?.pause(); } catch { /* ignored */ }
    setStatus('idle');
  };

  /* --------------------------- Cleanup on unmount ------------------------ */
  useEffect(() => () => wsRef.current?.close(), []);

  return { chatHistory, isChatting, status, startChat, stopChat };
}

/* -------------------------------------------------------------------------
   Helpers
--------------------------------------------------------------------------- */
function generateSessionId() {
  return (crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}