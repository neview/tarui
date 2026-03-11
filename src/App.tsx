import { useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";

import "./App.css";
import NavBar from "./components/NavBar/navBar";
import { LeftMenu } from "./components/LeftMenu/leftMenu";

function App() {
  return (
    <main className="container">
      <NavBar />
      <LeftMenu />
    </main>
  );
}

export default App;
