import { micromark } from "micromark";

export function renderDescription(markdown: string): string {
    // Keep raw HTML and executable link protocols disabled for stored content.
    return micromark(markdown, {
        allowDangerousHtml: false,
        allowDangerousProtocol: false,
    });
}
