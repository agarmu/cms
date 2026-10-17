import { expect, test } from "bun:test";
import { renderDescription } from "./photo-description";

test("formats description Markdown without changing its source", () => {
    const source =
        "## Context\n\nA **bird** above the _sea_.\n\n- First\n- Second";
    const preview = renderDescription(source);
    expect(preview).toContain("<h2>Context</h2>");
    expect(preview).toContain("<strong>bird</strong>");
    expect(preview).toContain("<em>sea</em>");
    expect(preview).toContain("<li>First</li>");
});

test("stored HTML is displayed as text and unsafe link protocols are removed", () => {
    const preview = renderDescription(
        "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert%281%29)\n\n![image](data:text/html,bad)",
    );
    expect(preview).not.toContain("<script");
    expect(preview).not.toContain("<img src=x");
    expect(preview).toContain("&lt;script&gt;");
    expect(preview).not.toContain('href="javascript:');
    expect(preview).not.toContain('src="data:');
});

test("links and code retain their intended content without creating HTML", () => {
    const preview = renderDescription(
        '[Details](https://example.com/details)\n\n```html\n<img onerror="alert(1)">\n```',
    );
    expect(preview).toContain(
        '<a href="https://example.com/details">Details</a>',
    );
    expect(preview).toContain('<code class="language-html">&lt;img');
    expect(preview).not.toContain("<img");
});
