import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import icon from "astro-icon";

export default defineConfig({
    integrations: [icon({ include: { lucide: ["github", "sun", "moon"] } })],
    vite: {
        plugins: [tailwindcss()],
    },
});
