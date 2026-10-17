import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";
import icon from "astro-icon";
import { ApplicationConfig } from "./config.ts";

const config = await ApplicationConfig.fromFile(
    new URL("./config.toml", import.meta.url),
);

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
    integrations: [
        icon({
            include: {
                lucide: [
                    "github",
                    "sun",
                    "moon",
                    "eye",
                    "eye-off",
                    "arrow-left",
                    "camera",
                    "camera-off",
                    "aperture",
                    "clock",
                    "image-up",
                    "plus",
                ],
            },
        }),
    ],
    vite: {
        define: { __CMS_CONFIG__: JSON.stringify(config) },
        plugins: [tailwindcss()],
    },
});
