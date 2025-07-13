import { useState, useEffect, useRef } from 'react';
import { Canvas } from "@react-three/fiber";
import AudioBlob from "./components/blob/index.jsx";
import { MathUtils } from "three";
import './App.css';
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
      content: 'Hello, I\'m here to listen. How can I assist you today?',
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

  useEffect(() => {
    const chatContainer = document.getElementById('chat-messages');
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }, [chatHistory]);


  /****************************** CONTROL ******************************/
  const startChat = async () => {
    if (isChatting) return;

    chatActiveRef.current = true;
    setIsChatting(true);
    if (userVisualizerRef.current) {
      userVisualizerRef.current.material.uniforms.u_intensity.value = 0.3;
      userVisualizerRef.current.scale.set(0.8, 0.8, 0.8);
    }

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
        userVisualizerRef.current.material.uniforms.u_intensity.value = 0.3;
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
  
      chunksRef.current = [];
      mediaRecRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  
      let silenceStartTime = null;
      const SILENCE_THRESHOLD = 10; // volume threshold
      const MAX_SILENCE_MS = 4000;
  
      const silenceCheckLoop = () => {
        if (!chatActiveRef.current || !mediaRecRef.current || mediaRecRef.current.state !== 'recording') return;
  
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const average = data.reduce((a, b) => a + b, 0) / data.length;
  
        if (average < SILENCE_THRESHOLD) {
          if (silenceStartTime === null) {
            silenceStartTime = Date.now();
          } else if (Date.now() - silenceStartTime > MAX_SILENCE_MS) {
            mediaRecRef.current.stop();
            return;
          }
        } else {
          silenceStartTime = null; // reset if noise detected
        }
  
        requestAnimationFrame(silenceCheckLoop);
      };
  
      mediaRecRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
  
      mediaRecRef.current.onstop = async () => {
        if (!chatActiveRef.current) return;
        stopUserRecording();
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
        await uploadAndTranscribe(audioBlob);
      };
  
      mediaRecRef.current.start();
      silenceCheckLoop(); // Start silence monitoring
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
      if (!chatActiveRef.current) return;

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

      if (transcript && transcript.trim() !== "") {
        appendMessage('user', transcript);
        turnRef.current += 1; // next user turn index
        speakAsAI(transcript);
      } else {
        // If transcript is empty, just continue listening
        listenToUser();
      }

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
            // Add space before token if it's not the first token and doesn't start with punctuation
            const needsSpace = fullReply.length > 0 && 
              !token.match(/^[.,!?;:]/) && 
              !fullReply.endsWith(' ') && 
              !fullReply.endsWith('\n');
            
            const tokenWithSpace = needsSpace ? ' ' + token : token;
            fullReply += tokenWithSpace;
            onToken(tokenWithSpace, fullReply);
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

      // Start visualising once playback actually begins
      visualiseAssistant(assistantAnalyser);

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
      const targetIntensity = MathUtils.clamp(level / 40, 0.1, 1.2); // less jumpy
const current = userVisualizerRef.current.material.uniforms.u_intensity.value;
const easedIntensity = MathUtils.lerp(current, targetIntensity, 0.1); // ease rate
userVisualizerRef.current.material.uniforms.u_intensity.value = easedIntensity;
      

const s = 0.8 + easedIntensity * 0.4;
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
      const targetIntensity = MathUtils.clamp(level / 40, 0.1, 1.2); // less jumpy
const current = userVisualizerRef.current.material.uniforms.u_intensity.value;
const easedIntensity = MathUtils.lerp(current, targetIntensity, 0.1); // ease rate
userVisualizerRef.current.material.uniforms.u_intensity.value = easedIntensity;
      
const s = 0.8 + easedIntensity * 0.4;
userVisualizerRef.current.scale.set(s, s, s);
    }

    if (audioRef.current) {
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
        userVisualizerRef.current.material.uniforms.u_intensity.value = 0.3;
      }
    }
  };

  /****************************** RENDER ******************************/
  return (
    <div className="min-h-screen bg-gray-100 w-dvw p-[16px] flex items-center justify-center p-4 font-inter">
      {/* Main chat window container */}
      <div className="relative lg:!w-[80%] xl:!w-[80%] h-[80vh]  w-full  bg-white rounded-2xl shadow-xl flex flex-col overflow-hidden">
        {/* Chat header */}
        <div className="p-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-center text-xl font-semibold rounded-t-2xl shadow-md">
          AI Therapist
        </div>

        {/* Message display area */}
        <div id="chat-messages" className="flex-1 p-4 overflow-y-auto custom-scrollbar">
          {chatHistory.map((message, index) => (
            <div
              key={index}
              className={`flex mb-4 ${
                message.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[75%] px-4 py-2 rounded-xl shadow-sm ${
                  message.role === 'user'
                    ? 'bg-blue-500 text-white rounded-br-none'
                    : 'bg-gray-200 text-gray-800 rounded-bl-none'
                }`}
              >
                {message.content}
              </div>
            </div>
          ))}
        </div>

        {/* Mic icon at the bottom */}
        <div className="p-4 bg-white border-t border-gray-200 flex justify-center items-center">
          <button
            onClick={isChatting ? stopChat : startChat}
            className="p-3 bg-gradient-to-r from-purple-500 to-indigo-500 text-white rounded-full shadow-lg hover:shadow-xl focus:outline-none focus:ring-4 focus:ring-purple-300 transition-all duration-200 ease-in-out transform hover:scale-105"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-7 w-7"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Blob Canvas Overlay */}
      {isChatting && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 20,
          pointerEvents: 'none'
        }}>
          <Canvas style={{ 
            width: 500, 
            height: 500
          }}>
            <ambientLight intensity={0.5} />
            <directionalLight position={[5, 5, 5]} />
            <AudioBlob ref={userVisualizerRef} />
          </Canvas>
        </div>
      )}

      {/* Custom scrollbar styles */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }

        .custom-scrollbar::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 10px;
        }

        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 10px;
        }

        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #555;
        }

        /* Inter font import */
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        
        .font-inter {
          font-family: 'Inter', sans-serif;
        }
      `}</style>
    </div>
  );
}