import React from "react";
import ReactDOM from "react-dom/client";
import { AppProvider } from "./AppContext";
import App from "./App";

import "ol/ol.css";
import "./style.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
);
