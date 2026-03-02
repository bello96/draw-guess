import { useState } from "react";
import { tx } from "@twind/core";
import Home from "./pages/Home";
import Room from "./pages/Room";

export default function App() {
  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("");

  if (roomCode) {
    return (
      <Room
        roomCode={roomCode}
        playerName={playerName}
        onLeave={() => {
          setRoomCode("");
          setPlayerName("");
        }}
      />
    );
  }

  return (
    <div className={tx("min-h-screen bg-gradient-to-br from-indigo-50 to-purple-50")}>
      <Home
        onEnterRoom={(code, name) => {
          setPlayerName(name);
          setRoomCode(code);
        }}
      />
    </div>
  );
}
