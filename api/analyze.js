
async function fetchWithRetry(url, options, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response;

    try {
      response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      if (error.name === "TimeoutError" ||
        error.name === "AbortError") {
        if (attempt === maxAttempts - 1) {
          throw new Error(
            "The AI request timed out after multiple attempts. Please try again later."
          );
        }
      } else if (attempt === maxAttempts - 1) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(resolve, 1000 * (2 ** attempt))
      );

      continue;
    }

    // Never retry 429 responses. They may indicate
    // an exhausted daily quota.
    if (response.status === 429) return response;

    // Retry only temporary server errors.
    if (![500, 503].includes(response.status)) {
      return response;
    }

    if (attempt === maxAttempts - 1) return response;

    await response.body?.cancel();

    await new Promise(resolve =>
      setTimeout(resolve, 1000 * (2 ** attempt))
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Server API key is not configured."
    });
  }

  try {
    const { resume, jobDescription, systemPrompt } = req.body || {};

    if (
      typeof resume !== "string" || !resume.trim() ||
      typeof jobDescription !== "string" ||
      !jobDescription.trim() ||
      typeof systemPrompt !== "string"
    ) {
      return res.status(400).json({
        error: "Resume, job description, and prompt are required."
      });
    }

    const prompt =
      systemPrompt +
      "\n\nResume:\n" + resume +
      "\n\nJob Description:\n" + jobDescription +
      "\n\nProvide your analysis as a JSON object with the exact fields specified.";

    const response = await fetchWithRetry(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            responseMimeType: "application/json"
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const details =
        data.error?.message || "Unknown Gemini API error";

      console.error(
        "Gemini request failed:",
        response.status,
        details
      );

      if (response.status === 429) {
        const dailyQuota =
          /per day|daily quota|requests per day|\bRPD\b|per_day/i.test(details);

        if (dailyQuota) {
          return res.status(429).json({
            error:
              "The AI service has reached its daily free-tier quota. Please try again after the quota resets. No retries were made."
          });
        }

        return res.status(429).json({
          error:
            "The AI service is temporarily rate-limited. Please wait a short time before trying again. No retries were made."
        });
      }

      return res.status(502).json({
        error: `Gemini API error (${response.status}): ${details}`
      });
    }

    const aiResponse =
      data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!aiResponse) {
      return res.status(502).json({
        error: "Gemini returned an empty response."
      });
    }

    let analysis;

    try {
      analysis = JSON.parse(aiResponse);
    } catch {
      return res.status(502).json({
        error: "Gemini returned invalid JSON. Please try again."
      });
    }

    if (
      typeof analysis.ats_score !== "number" ||
      !Array.isArray(analysis.strengths) ||
      !Array.isArray(analysis.missing_keywords) ||
      !Array.isArray(analysis.improvements)
    ) {
      return res.status(502).json({
        error: "Gemini returned an incomplete analysis."
      });
    }

    return res.status(200).json({ analysis });
  } catch (error) {
    console.error(
      "Analysis endpoint error:",
      error.message
    );

    return res.status(500).json({
      error: "An unexpected server error occurred."
    });
  }
}
