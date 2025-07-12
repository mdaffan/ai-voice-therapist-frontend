import { useState, useEffect, useRef } from 'react';
import './App.css';
import { Canvas } from "@react-three/fiber";
import VisualBlob from "./components/blob/index.jsx";
import { MathUtils } from "three";
// Generate a unique ID for each conversation session
function newSessionId() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

export default function App() {
  const [isChatting, setIsChatting] = useState(false);
  const [chatHistory, setChatHistory] = useState([
    {
      role: 'assistant',
      content: 'Hello, how can I help you today? Press the start button to chat.',
    },
  ]);

  // DOM / audio refs
  const userVisualizerRef = useRef(null);
  const audioRef = useRef(null); // Holds currently playing assistant audio
  const streamRef = useRef(null);
  const animationIdRef = useRef(null);
  const contextRef = useRef(null);

  // MediaRecorder refs
  const mediaRecRef = useRef(null);
  const chunksRef = useRef([]);

  // Conversation bookkeeping
  const sessionIdRef = useRef(newSessionId()); // UUID for this tab/session
  const turnRef = useRef(0); // 0, 1, 2 … user turns
  const chatActiveRef = useRef(false); // single source of truth
  const currentSpeakerRef = useRef(null); // 'user' | 'assistant' | null

  const API_BASE = 'http://localhost:9000';

  /****************************** LIFECYCLE ******************************/
  useEffect(() => {
    return () => {
      hardCleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /****************************** CONTROL ******************************/
  const startChat = async () => {
    if (isChatting) return;

    chatActiveRef.current = true;
    setIsChatting(true);

    contextRef.current = new (window.AudioContext || window.webkitAudioContext)();

    // Begin the conversation loop
    listenToUser();
  };

  const stopChat = () => {
    if (!chatActiveRef.current) return; // already stopped

    chatActiveRef.current = false;
    setIsChatting(false);

    stopUserRecording();
    hardCleanup();
  };

  /****************************** CLEANUP HELPERS ******************************/
  const hardCleanup = () => {
    // cancel looping animation
    if (animationIdRef.current) {
      cancelAnimationFrame(animationIdRef.current);
      animationIdRef.current = null;
    }

    // stop MediaRecorder if running
    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      try {
        mediaRecRef.current.stop();
      } catch {
        /* ignored */
      }
      mediaRecRef.current = null;
    }

    // stop media tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    // reset visualiser
    if (userVisualizerRef.current) {
      userVisualizerRef.current.scale.set(0.8, 0.8, 0.8);
      if (userVisualizerRef.current.material) {
        userVisualizerRef.current.material.uniforms.u_intensity.value = 0.15;
      }
    }

    // close audio context
    if (contextRef.current) {
      try {
        contextRef.current.close();
      } catch {
        /* ignored */
      }
      contextRef.current = null;
    }

    // stop any playing assistant audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  };

  /****************************** CONVERSATION FLOW ******************************/
  const listenToUser = async () => {
    if (!chatActiveRef.current) return;

    currentSpeakerRef.current = 'user';

    try {
      // ensure fresh stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const source = contextRef.current.createMediaStreamSource(stream);
      const analyser = contextRef.current.createAnalyser();
      source.connect(analyser);
      visualiseUser(analyser);

      // ---------- MediaRecorder ----------
      chunksRef.current = [];
      mediaRecRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      // Silence detection helper
      let silenceTimer;
      const resetSilenceTimer = () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
            mediaRecRef.current.stop();
          }
        }, 4000); // 4 s of inactivity ends the turn
      };

      mediaRecRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          resetSilenceTimer();
        }
      };

      mediaRecRef.current.onstop = async () => {
        stopUserRecording();
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        await uploadAndTranscribe(blob);
      };

      mediaRecRef.current.start();
      resetSilenceTimer();
    } catch (err) {
      console.error('Error accessing microphone', err);
      if (chatActiveRef.current) {
        setTimeout(listenToUser, 1000);
      }
    }
  };

  /****************************** SERVER I/O ******************************/
  const uploadAndTranscribe = async (blob) => {
    try {
      const form = new FormData();
      form.append('file', blob, 'speech.webm');
      form.append('session_id', sessionIdRef.current);
      form.append('turn', String(turnRef.current));

      const res = await fetch('http://localhost:9000/stt', {
        method: 'POST',
        body: form,
      });

      const data = await res.json();
      const transcript = data.text || '';

      appendMessage('user', transcript);
      turnRef.current += 1; // next user turn index

      speakAsAI(transcript);
    } catch (err) {
      console.error('Failed to transcribe', err);
      if (chatActiveRef.current) {
        setTimeout(listenToUser, 1000);
      }
    }
  };

  // Stream assistant reply via SSE-like response body
  const streamAssistantResponse = async (prompt, onToken) => {
    const res = await fetch(`${API_BASE}/chat_stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt }),
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
      buffer = parts.pop(); // keep incomplete piece

      parts.forEach((part) => {
        if (part.startsWith('data:')) {
          const token = part.replace(/^data:\s*/, '');
          if (token) {
            fullReply += token;
            onToken(token, fullReply);
          }
        }
      });
    }

    return fullReply;
  };

  const fetchSpeech = async (text) => {
    // Stream audio via MediaSource so playback can start immediately
    const res = await fetch(`${API_BASE}/tts_stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    return res.body; // ReadableStream of audio bytes
  };

  const speakAsAI = async (prompt) => {
    if (!chatActiveRef.current) return;

    currentSpeakerRef.current = 'assistant';

    try {
      // 1) Stream assistant text reply
      // create placeholder assistant message and capture its index in state safely
      let assistantIndex = null;
      setChatHistory((prev) => {
        assistantIndex = prev.length; // position where new message will be inserted
        return [...prev, { role: 'assistant', content: '' }];
      });

      const updateAssistantBubble = (_, currentFull) => {
        setChatHistory((prev) => {
          if (assistantIndex === null) return prev; // should not happen
          // If for any reason the index is out of range, append instead of overwrite
          if (assistantIndex >= prev.length) {
            return [...prev, { role: 'assistant', content: currentFull }];
          }
          const arr = [...prev];
          arr[assistantIndex] = { role: 'assistant', content: currentFull };
          return arr;
        });
      };

      const content = await streamAssistantResponse(prompt, updateAssistantBubble);

      // 2) Turn final text into speech
      const audioStream = await fetchSpeech(content);

      const audio = new Audio();
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      audio.src = objectUrl;

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

      audioRef.current = audio;

      // Connect audio element to WebAudio analyser for visualisation
      const assistantSource = contextRef.current.createMediaElementSource(audio);
      const assistantAnalyser = contextRef.current.createAnalyser();
      assistantSource.connect(assistantAnalyser);
      assistantAnalyser.connect(contextRef.current.destination);

      visualiseAssistant(assistantAnalyser);

      audio.onended = () => {
        URL.revokeObjectURL(objectUrl);
        if (animationIdRef.current) {
          cancelAnimationFrame(animationIdRef.current);
          animationIdRef.current = null;
        }
        if (chatActiveRef.current) {
          listenToUser();
        }
      };
      await audio.play();
    } catch (err) {
      console.error('Assistant error', err);
      if (chatActiveRef.current) {
        setTimeout(listenToUser, 1000);
      }
    }
  };

  /****************************** UTILITIES ******************************/
  const appendMessage = (role, content) => {
    setChatHistory((prev) => [...prev, { role, content }]);
  };

  const visualiseUser = (analyser) => {
    if (!chatActiveRef.current) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const level = data.reduce((a, b) => a + b, 0) / data.length;

    if (userVisualizerRef.current && userVisualizerRef.current.material) {
      // Map microphone input to blob intensity and scale
      const intensity = MathUtils.clamp(level / 80, 0, 1);
      userVisualizerRef.current.material.uniforms.u_intensity.value = intensity;

      const s = intensity + 0.8;
      userVisualizerRef.current.scale.set(s, s, s);
    }

    animationIdRef.current = requestAnimationFrame(() => visualiseUser(analyser));
  };

  // Visualise assistant speech using the same blob
  const visualiseAssistant = (analyser) => {
    if (!chatActiveRef.current) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const level = data.reduce((a, b) => a + b, 0) / data.length;

    if (userVisualizerRef.current && userVisualizerRef.current.material) {
      const intensity = MathUtils.clamp(level / 80, 0, 1);
      userVisualizerRef.current.material.uniforms.u_intensity.value = intensity;
      const s = intensity + 0.8;
      userVisualizerRef.current.scale.set(s, s, s);
    }

    if (audioRef.current && !audioRef.current.paused) {
      animationIdRef.current = requestAnimationFrame(() => visualiseAssistant(analyser));
    }
  };

  const stopUserRecording = () => {
    if (animationIdRef.current) {
      cancelAnimationFrame(animationIdRef.current);
      animationIdRef.current = null;
    }

    if (mediaRecRef.current && mediaRecRef.current.state !== 'inactive') {
      try {
        mediaRecRef.current.stop();
      } catch {
        /* ignored */
      }
      mediaRecRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (userVisualizerRef.current) {
      userVisualizerRef.current.scale.set(0.8, 0.8, 0.8);
      if (userVisualizerRef.current.material) {
        userVisualizerRef.current.material.uniforms.u_intensity.value = 0.15;
      }
    }
  };

  /****************************** RENDER ******************************/
  return (
    <div className="app">
      <button className="toggle-btn" onClick={isChatting ? stopChat : startChat}>
        {isChatting ? 'Stop' : 'Start'}
      </button>

      {isChatting && (
        <Canvas style={{ width: 100, height: 100 }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[5, 5, 5]} />
          <VisualBlob ref={userVisualizerRef} />
        </Canvas>
      )}
      <div className="chat-history">
        {chatHistory.map((m, i) => (
          <p key={i} className={`speech-bubble ${m.role}`}>
            {m.content}
          </p>
        ))}
      </div>
    </div>
  );
}


