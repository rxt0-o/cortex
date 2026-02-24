const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
function getGeminiKey() {
    return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null;
}
function getGeminiModel() {
    return process.env.CORTEX_GEMINI_MODEL ?? 'gemini-1.5-flash';
}
export function isGeminiAvailable() {
    return Boolean(getGeminiKey());
}
export async function summarizeWithGemini(input) {
    const apiKey = getGeminiKey();
    if (!apiKey)
        return null;
    const model = getGeminiModel();
    const maxOutputTokens = input.maxOutputTokens ?? 600;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
        const response = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                text: [
                                    `Task: ${input.title}`,
                                    '',
                                    'Create a concise technical summary in bullet points.',
                                    'Include key decisions, risks, and suggested next actions.',
                                    '',
                                    'Input:',
                                    input.text.slice(0, 120_000),
                                ].join('\n'),
                            },
                        ],
                    },
                ],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens,
                },
            }),
        });
        if (!response.ok)
            return null;
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts
            ?.map((p) => p.text ?? '')
            .join('\n')
            .trim();
        return text || null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=gemini.js.map