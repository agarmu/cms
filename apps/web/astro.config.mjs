import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";
import icon from "astro-icon";

export default defineConfig({
    fonts: [
        {
            provider: fontProviders.fontsource(),
            name: "Atkinson Hyperlegible",
            cssVariable: "--font-atkinson-hyperlegible",
            weights: [400, 700],
            styles: ["normal"],
            subsets: ["latin"],
        },
    ],
    integrations: [icon({ include: { lucide: ["github", "sun", "moon"] } })],
    vite: {
        plugins: [tailwindcss()],
    },
});
