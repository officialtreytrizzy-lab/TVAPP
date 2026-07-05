import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const mobileStudioAudioJsxHotfix = () => ({
  name: "mobile-studio-audio-jsx-hotfix",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.endsWith("src/components/opencut-mobile/MobileOpenCutStudio.tsx")) return null;
    return code.replace(
      '</label></div>))}<p className="text-xs leading-5 text-white/40">Preview uses the first audio track.',
      '</label></div>)}<p className="text-xs leading-5 text-white/40">Preview uses the first audio track.',
    );
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: [".vercel.run"],
  },
  plugins: [
    mobileStudioAudioJsxHotfix(),
    react()
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
