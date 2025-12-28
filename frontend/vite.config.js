import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["vps-1e328c3e", "100.67.158.38"],
    proxy: {
      "/api": "http://localhost:8080"
    }
  }
});
