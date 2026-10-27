import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const element = document.getElementById("root");
if (!element) throw new Error("The application root is unavailable.");
createRoot(element).render(<StrictMode><App /></StrictMode>);
