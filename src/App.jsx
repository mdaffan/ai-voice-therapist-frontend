import { useRef, useEffect } from 'react';
import { Canvas } from "@react-three/fiber";
import AudioBlob from "./components/blob/index.jsx";
import useVoiceChat from "./hooks/useVoiceChatWS.js";
import './App.css';

export default function App() {
  const userVisualizerRef = useRef(null);
  const { chatHistory, isChatting, startChat, stopChat, status } = useVoiceChat(userVisualizerRef);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const chatContainer = document.getElementById('chat-messages');
    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
  }, [chatHistory]);

  return (
    <div className="min-h-screen bg-gray-100 w-dvw p-[16px] flex items-center justify-center font-inter">
      {/* Main chat window */}
      <div className="relative lg:!w-[80%] xl:!w-[80%] h-[80vh] w-full bg-white rounded-2xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-center text-xl font-semibold rounded-t-2xl shadow-md">
          AI Therapist
        </div>

        {/* Messages */}
        <div id="chat-messages" className="flex-1 p-4 overflow-y-auto custom-scrollbar">
          {chatHistory.map((msg, idx) => (
            <div key={idx} className={`flex mb-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] px-4 py-2 rounded-xl shadow-sm ${msg.role === 'user' ? 'bg-blue-500 text-white rounded-br-none' : 'bg-gray-200 text-gray-800 rounded-bl-none'}`}>{msg.content}</div>
            </div>
          ))}
        </div>

        {/* Mic toggle */}
        <div className="p-4 bg-white border-t border-gray-200 flex justify-center items-center">
          <button onClick={isChatting ? stopChat : startChat} className="p-3 bg-gradient-to-r from-purple-500 to-indigo-500 text-white rounded-full shadow-lg hover:shadow-xl focus:outline-none focus:ring-4 focus:ring-purple-300 transition-all duration-200 ease-in-out transform hover:scale-105">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Overlay blob + End button while chatting */}
      {isChatting && (
        <div className="fixed top-0 left-0 w-dvw h-dvh flex items-center justify-center z-20 bg-black/50 backdrop-blur-sm pointer-events-auto">
          {status !== 'idle' && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 px-3 py-1 bg-white/60 text-gray-700 text-xs rounded-full shadow backdrop-blur-md z-30">
              {status === 'listening' && 'Listening…'}
              {status === 'transcribing' && 'Transcribing…'}
              {status === 'speaking' && 'Speaking…'}
            </div>
          )}
          <button onClick={stopChat} className="absolute bottom-10 left-1/2 -translate-x-1/2 px-6 py-3 bg-red-600 text-white rounded-full shadow-lg hover:shadow-xl focus:outline-none focus:ring-4 focus:ring-red-300 transition-all duration-200 ease-in-out hover:scale-105 z-30">
            End voice
          </button>

          <Canvas style={{ width: 500, height: 500, pointerEvents: 'none' }}>
            <ambientLight intensity={0.5} />
            <directionalLight position={[5, 5, 5]} />
            <AudioBlob ref={userVisualizerRef} />
          </Canvas>
        </div>
      )}

      {/* Custom scroll bar + font */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #888; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #555; }
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        .font-inter { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}