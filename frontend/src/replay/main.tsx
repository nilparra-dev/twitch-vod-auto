import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "../index.css";
import { ReplayPlayer } from "./ReplayPlayer";

const root = document.getElementById("root");
if (!root) throw new Error("Player root is missing.");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <main className="replay-standalone">
      <ReplayPlayer />
    </main>
  </React.StrictMode>,
);
