import { useState, useRef, useCallback, useEffect } from 'react';
import { MathUtils } from 'three';

/**
 * useVoiceChat – abstracts the Web-Audio / MediaRecorder loop and backend calls 
 * so that UI components only deal with high-level chat state.
 */
export default function useVoiceChat(userVisualizerRef, apiBase = import.meta.env.VITE_API_BASE || 'http://localhost:9000') {
  const [isChatting, setIsChatting] = useState(false);
  const [chatHistory, setChatHistory] = useState([
    { role: 'assistant', content: "Hello, I'm here to listen. How can I assist you today?" },
  ]);
  const [status, setStatus] = useState('idle'); // idle | listening | transcribing | speaking

  const sessionIdRef = useRef(newSessionId());
  const turnRef = useRef(0);

  const audioRef = useRef(null);            // Currently playing assistant Audio element
  const streamRef = useRef(null);           // Active microphone MediaStream
  const animationIdRef = useRef(null);      // requestAnimationFrame ID
  const contextRef = useRef(null);          // WebAudio context
  const mediaRecRef = useRef(null);         // MediaRecorder instance
  const chunksRef = useRef([]);             // Audio chunks being recorded

  const chatActiveRef = useRef(false);      // Single source-of-truth flag
  const currentSpeakerRef = useRef(null);   // 'user' | 'assistant' | null

  const appendMessage = (role, content) => setChatHistory(prev => [...prev, { role, content }]);

  /** Reset everything (called when chat ends or component unmounts) */
  const hardCleanup = useCallback(() => {
    if (animationIdRef.current) {
      cancelAnimationFrame(animationIdRef.current);
      animationIdRef.current = null;
    }

    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      try { mediaRecRef.current.stop(); } catch { /* ignored */ }
      mediaRecRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    if (userVisualizerRef?.current) {
      userVisualizerRef.current.scale.set(0.8, 0.8, 0.8);
      const mat = userVisualizerRef.current.material;
      if (mat?.uniforms?.u_intensity) mat.uniforms.u_intensity.value = 0.3;
    }

    if (contextRef.current) {
      try { contextRef.current.close(); } catch { /* ignored */ }
      contextRef.current = null;
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setStatus('idle');
  }, [userVisualizerRef]);

  /** Stop MediaRecorder + mic and reset blob visual */
  const stopUserRecording = useCallback(() => {
    if (animationIdRef.current) {
      cancelAnimationFrame(animationIdRef.current);
      animationIdRef.current = null;
    }

    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      try { mediaRecRef.current.stop(); } catch { /* ignored */ }
      mediaRecRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    if (userVisualizerRef?.current) {
      userVisualizerRef.current.scale.set(0.8, 0.8, 0.8);
      const mat = userVisualizerRef.current.material;
      if (mat?.uniforms?.u_intensity) mat.uniforms.u_intensity.value = 0.3;
    }
  }, [userVisualizerRef]);

  /** Visualise microphone or TTS playback using the blob mesh */
  const visualise = (analyser, source) => {
    if (!chatActiveRef.current) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const level = data.reduce((a, b) => a + b, 0) / data.length;

    if (userVisualizerRef?.current && userVisualizerRef.current.material) {
      const target = MathUtils.clamp(level / 40, 0.1, 1.2);
      const current = userVisualizerRef.current.material.uniforms.u_intensity.value;
      const eased = MathUtils.lerp(current, target, 0.1);
      userVisualizerRef.current.material.uniforms.u_intensity.value = eased;

      const s = 0.8 + eased * 0.4;
      userVisualizerRef.current.scale.set(s, s, s);
    }

    if (source === 'user' || audioRef.current) {
      animationIdRef.current = requestAnimationFrame(() => visualise(analyser, source));
    }
  };

  /** Upload mic recording → STT → handle reply */
  const uploadAndTranscribe = useCallback(async (blob) => {
    try {
      if (!chatActiveRef.current) return;
      setStatus('transcribing');

      const form = new FormData();
      form.append('file', blob, 'speech.webm');
      form.append('session_id', sessionIdRef.current);
      form.append('turn', String(turnRef.current));

      const res = await fetch(`${apiBase}/stt`, { method: 'POST', body: form });
      const data = await res.json();
      const transcript = data.text || '';

      if (transcript.trim()) {
        appendMessage('user', transcript);
        turnRef.current += 1;
        await speakAsAI(transcript);
      } else {
        listenToUser();
      }
    } catch (err) {
      console.error('Failed to transcribe', err);
      if (chatActiveRef.current) setTimeout(listenToUser, 1000);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Listen to user via microphone until silence detected */
  const listenToUser = useCallback(async () => {
    if (!chatActiveRef.current) return;
    setStatus('listening');
    currentSpeakerRef.current = 'user';

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sourceNode = contextRef.current.createMediaStreamSource(stream);
      const analyser = contextRef.current.createAnalyser();
      sourceNode.connect(analyser);
      visualise(analyser, 'user');

      chunksRef.current = [];
      mediaRecRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      let silenceStart = null;
      const THRESHOLD = 10;
      const MAX_SILENCE_MS = 2000;
      let hasSpoken = false;

      const silenceLoop = () => {
        if (!chatActiveRef.current || mediaRecRef.current?.state !== 'recording') return;

        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;

        if (avg >= THRESHOLD) {
          hasSpoken = true;
          silenceStart = null;
        } else if (hasSpoken) {
          if (silenceStart === null) silenceStart = Date.now();
          else if (Date.now() - silenceStart > MAX_SILENCE_MS) {
            mediaRecRef.current.stop();
            return;
          }
        }
        requestAnimationFrame(silenceLoop);
      };

      mediaRecRef.current.ondataavailable = e => {
        if (e.data.size) chunksRef.current.push(e.data);
      };

      mediaRecRef.current.onstop = async () => {
        if (!chatActiveRef.current) return;
        stopUserRecording();
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        await uploadAndTranscribe(blob);
      };

      mediaRecRef.current.start();
      silenceLoop();
    } catch (err) {
      console.error('Error accessing microphone', err);
      if (chatActiveRef.current) setTimeout(listenToUser, 1000);
    }
  }, [stopUserRecording, uploadAndTranscribe]);

  /** Stream assistant tokens, then stream TTS audio */
  const speakAsAI = useCallback(async (prompt) => {
    if (!chatActiveRef.current) return;
    setStatus('speaking');
    currentSpeakerRef.current = 'assistant';

    try {
      let assistantIdx = null;
      setChatHistory(prev => {
        assistantIdx = prev.length;
        return [...prev, { role: 'assistant', content: '' }];
      });

      const fullText = await streamAssistantResponse(prompt, (token, accumulated) => {
        setChatHistory(prev => {
          if (assistantIdx === null) return prev;
          const arr = [...prev];
          if (assistantIdx >= arr.length) arr.push({ role: 'assistant', content: accumulated });
          else arr[assistantIdx] = { role: 'assistant', content: accumulated };
          return arr;
        });
      });

      const audioStream = await fetchSpeech(fullText);

      let audio;
      let url;

      const canUseMSE = typeof window !== 'undefined' && 'MediaSource' in window && MediaSource.isTypeSupported('audio/mpeg');

      if (canUseMSE) {
        /* -------------------- Stream via MSE (desktop + most Android) -------------------- */
        const mediaSource = new MediaSource();
        url = URL.createObjectURL(mediaSource);
        audio = new Audio();
        audio.src = url;

        mediaSource.addEventListener('sourceopen', async () => {
          const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
          const reader = audioStream.getReader();
          const pump = async () => {
            const { value, done } = await reader.read();
            if (done) {
              if (!sourceBuffer.updating) mediaSource.endOfStream();
              else sourceBuffer.addEventListener('updateend', () => mediaSource.endOfStream(), { once: true });
              return;
            }
            sourceBuffer.appendBuffer(value);
            if (!sourceBuffer.updating) pump();
            else sourceBuffer.addEventListener('updateend', pump, { once: true });
          };
          pump();
        }, { once: true });
      } else {
        /* -------------------- Fallback: buffer entire audio then play -------------------- */
        const chunks = [];
        const reader = audioStream.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const blob = new Blob(chunks, { type: 'audio/mpeg' });
        url = URL.createObjectURL(blob);
        audio = new Audio(url);
      }

      audioRef.current = audio;

      const assistantSource = contextRef.current.createMediaElementSource(audio);
      const assistantAnalyser = contextRef.current.createAnalyser();
      assistantSource.connect(assistantAnalyser);
      assistantAnalyser.connect(contextRef.current.destination);

      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (animationIdRef.current) {
          cancelAnimationFrame(animationIdRef.current);
          animationIdRef.current = null;
        }
        if (chatActiveRef.current) listenToUser();
      };

      await audio.play();
      visualise(assistantAnalyser, 'assistant');
    } catch (err) {
      console.error('Assistant error', err);
      if (chatActiveRef.current) setTimeout(listenToUser, 1000);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Stream assistant text tokens */
  const streamAssistantResponse = async (prompt, onToken) => {
    const res = await fetch(`${apiBase}/chat_stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt, session_id: sessionIdRef.current }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullReply = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      parts.forEach(part => {
        if (part.startsWith('data:')) {
          const token = part.replace(/^data:\s*/, '');
          if (token) {
            const needsSpace = fullReply.length && !token.match(/^[.,!?;:]/) && !fullReply.endsWith(' ') && !fullReply.endsWith('\n');
            const t = needsSpace ? ' ' + token : token;
            fullReply += t;
            onToken(t, fullReply);
          }
        }
      });
    }
    return fullReply;
  };

  /** Fetch TTS audio stream */
  const fetchSpeech = async (text) => {
    const res = await fetch(`${apiBase}/tts_stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.body;
  };

  /* -------------------- Public API -------------------- */
  const startChat = useCallback(() => {
    if (isChatting) return;
    chatActiveRef.current = true;
    setIsChatting(true);
    setStatus('listening');

    if (userVisualizerRef?.current?.material?.uniforms) {
      userVisualizerRef.current.material.uniforms.u_intensity.value = 0.3;
      userVisualizerRef.current.scale.set(0.8, 0.8, 0.8);
    }

    contextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    listenToUser();
  }, [isChatting, listenToUser, userVisualizerRef]);

  const stopChat = useCallback(() => {
    if (!chatActiveRef.current) return;
    chatActiveRef.current = false;
    setIsChatting(false);
    setStatus('idle');
    stopUserRecording();
    hardCleanup();
  }, [stopUserRecording, hardCleanup]);

  /* Cleanup on unmount */
  useEffect(() => hardCleanup, [hardCleanup]);

  return { chatHistory, isChatting, startChat, stopChat, status };
}

/** Generate a unique id for each browser session */
function newSessionId() {
  return (crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
} 