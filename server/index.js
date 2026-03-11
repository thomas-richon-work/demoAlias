import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, "../web");

const {
  ORANGE_API_BASE = "https://api.orange.com",
  ORANGE_APP_ID,

  ORANGE_TOKEN_URL = "https://api.orange.com/oauth/v3/token",
  ORANGE_CLIENT_ID,
  ORANGE_CLIENT_SECRET,
  ORANGE_SCOPES = "",

  SERVICE_ID,

  C2C_APP_ID = ORANGE_APP_ID,
  C2C_TOKEN_URL = ORANGE_TOKEN_URL,
  C2C_CLIENT_ID = ORANGE_CLIENT_ID,
  C2C_SECRET = ORANGE_CLIENT_SECRET,
  C2C_SCOPES = ORANGE_SCOPES,
  C2C_SERVICE_ID = SERVICE_ID,
  C2C_URI = "",
  OPENAI_API_KEY = "",
  OPENAI_MODEL = "gpt-4.1-mini",
  REGION = "EUR",
  CUSTOMER = "anbservices",
  PORT = 3001,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

app.use(express.static(webDir));

function orangeBasePath() {
  requireEnv("SERVICE_ID", SERVICE_ID);
  return (
	`/alias-numbers-alias2alias/v1/${encodeURIComponent(REGION)}` +
	`/${encodeURIComponent(CUSTOMER)}` +
	`/${encodeURIComponent(SERVICE_ID)}`
  );
}

// ---------------------------
// OAuth2 token cache
// ---------------------------
const tokenCaches = new Map();
const inflightTokenPromises = new Map();

function profileKey(profile) {
  return [
	profile.tokenUrl,
	profile.clientId,
	profile.scopes || "",
  ].join("::");
}

function getTokenCache(profile) {
  const key = profileKey(profile);
  if (!tokenCaches.has(key)) {
	tokenCaches.set(key, { accessToken: null, expiresAtMs: 0 });
  }
  return tokenCaches.get(key);
}

function isTokenValidSoon(profile, thresholdMs = 60_000) {
  const tokenCache = getTokenCache(profile);
  return tokenCache.accessToken && Date.now() + thresholdMs < tokenCache.expiresAtMs;
}

async function fetchClientCredentialsToken(profile) {
  requireEnv("clientId", profile.clientId);
  requireEnv("clientSecret", profile.clientSecret);

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");

  // Some OAuth servers accept scope; keep optional
  if (profile.scopes && profile.scopes.trim()) {
	params.set("scope", profile.scopes.trim());
  }

  // Many servers accept client_id/secret in body; others require Basic auth.
  // We do BOTH safely: Basic header + body client_id (body optional).
  const basic = Buffer.from(`${profile.clientId}:${profile.clientSecret}`).toString("base64");

  const r = await fetch(profile.tokenUrl, {
	method: "POST",
	headers: {
	  "Authorization": `Basic ${basic}`,
	  "Content-Type": "application/x-www-form-urlencoded",
	  "Accept": "application/json",
	},
	body: params.toString(),
  });

  const text = await r.text();
  if (!r.ok) {
	throw new Error(`Token endpoint error ${r.status}: ${text}`);
  }

  const data = text ? JSON.parse(text) : {};
  const accessToken = data.access_token;
  const expiresIn = Number(data.expires_in ?? 0); // seconds

  if (!accessToken || !expiresIn) {
	throw new Error(`Token response missing access_token/expires_in: ${text}`);
  }

  const tokenCache = getTokenCache(profile);
  tokenCache.accessToken = accessToken;
  tokenCache.expiresAtMs = Date.now() + expiresIn * 1000;

  return accessToken;
}

async function getAccessToken(profile) {
  const tokenCache = getTokenCache(profile);
  if (isTokenValidSoon(profile)) return tokenCache.accessToken;

  // De-duplicate concurrent refreshes
  const key = profileKey(profile);
  if (!inflightTokenPromises.has(key)) {
	inflightTokenPromises.set(key, (async () => {
	  try {
		return await fetchClientCredentialsToken(profile);
	  } finally {
		inflightTokenPromises.delete(key);
	  }
	})());
  }
  return await inflightTokenPromises.get(key);
}

function getAliasProfile() {
  return {
	appId: requireEnv("ORANGE_APP_ID", ORANGE_APP_ID),
	tokenUrl: ORANGE_TOKEN_URL,
	clientId: requireEnv("ORANGE_CLIENT_ID", ORANGE_CLIENT_ID),
	clientSecret: requireEnv("ORANGE_CLIENT_SECRET", ORANGE_CLIENT_SECRET),
	scopes: ORANGE_SCOPES,
	serviceId: requireEnv("SERVICE_ID", SERVICE_ID),
  };
}

function getFullProfile() {
  return {
	appId: requireEnv("C2C_APP_ID", C2C_APP_ID),
	tokenUrl: C2C_TOKEN_URL,
	clientId: requireEnv("C2C_CLIENT_ID", C2C_CLIENT_ID),
	clientSecret: requireEnv("C2C_SECRET", C2C_SECRET),
	scopes: C2C_SCOPES,
	serviceId: requireEnv("C2C_SERVICE_ID", C2C_SERVICE_ID),
	baseUri: C2C_URI,
  };
}

async function orangeHeaders(profile = getAliasProfile()) {
  const token = await getAccessToken(profile);
  return {
	"X-OAPI-Application-Id": profile.appId,
	"Authorization": `Bearer ${token}`,
	"Accept": "application/json",
  };
}

async function orangeFullHeaders() {
  const profile = getFullProfile();
  return {
	...(await orangeHeaders(profile)),
	"X-VNumbers-Service-Id": profile.serviceId,
  };
}

function buildSimulationFallbackReply(lastMessage) {
  const text = String(lastMessage || "").toLowerCase();
  if (!text) {
	return "Bonjour, je suis disponible pour vous aider sur votre demande de service.";
  }
  if (text.includes("prix") || text.includes("tarif") || text.includes("cout")) {
	return "Pour ce type d'intervention, nous confirmons un tarif transparent avant de valider le deplacement.";
  }
  if (text.includes("rdv") || text.includes("heure") || text.includes("dispon")) {
	return "Je peux vous proposer un passage aujourd'hui entre 14h et 16h ou demain matin entre 9h et 11h.";
  }
  if (text.includes("adresse") || text.includes("ou")) {
	return "Parfait, envoyez l'adresse exacte et un numero de contact, je confirme l'intervention immediatement.";
  }
  return "Merci pour votre message. Je confirme la prise en charge et je vous recontacte avec le prochain creneau disponible.";
}

async function buildSimulationOpenAiReply({ offer, messages }) {
  if (!OPENAI_API_KEY) return null;
  const safeMessages = Array.isArray(messages) ? messages.slice(-12) : [];
  const transcript = safeMessages
	.map((item) => {
	  const role = item?.sender === "left" ? "Annonceur" : "Client";
	  return `${role}: ${String(item?.text || "").trim()}`;
	})
	.filter(Boolean)
	.join("\n");
  const prompt = [
	"Tu joues un client dans une conversation de chat de mise en relation service.",
	`Annonce de service: ${String(offer || "").trim()}`,
	"Reponds en francais, en 1 ou 2 phrases, ton naturel et concret.",
	"N'ajoute pas de markdown.",
	"Conversation:",
	transcript,
  ].join("\n");

  const r = await fetch("https://api.openai.com/v1/responses", {
	method: "POST",
	headers: {
	  "Authorization": `Bearer ${OPENAI_API_KEY}`,
	  "Content-Type": "application/json",
	},
	body: JSON.stringify({
	  model: OPENAI_MODEL,
	  input: prompt,
	  temperature: 0.7,
	  max_output_tokens: 120,
	}),
  });

  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
	throw new Error(payload?.error?.message || `OpenAI HTTP ${r.status}`);
  }

  const reply = String(payload?.output_text || "").trim();
  if (!reply) {
	throw new Error("OpenAI response is empty");
  }
  return reply;
}

// ---------------------------
// Routes (proxy)
// ---------------------------

app.post("/api/simulation/chat-reply", async (req, res) => {
  try {
	const offer = String(req.body?.offer || "").trim();
	const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
	const lastUserMessage = String(messages[messages.length - 1]?.text || "").trim();

	let reply = null;
	try {
	  reply = await buildSimulationOpenAiReply({ offer, messages });
	} catch (openAiError) {
	  console.error("OpenAI simulation fallback:", openAiError);
	}
	if (!reply) {
	  reply = buildSimulationFallbackReply(lastUserMessage);
	}
	return res.json({ ok: true, reply });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.get("/api/inbound-rules/:externalNumber", async (req, res) => {
  try {
	const externalNumber = String(req.params.externalNumber || "").replace(/\D/g, "");
	if (!externalNumber) {
	  return res.status(400).json({ ok: false, message: "Missing external number" });
	}

	const fullProfile = getFullProfile();
	const baseUri = fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`;
	const url =
	  `${baseUri}` +
	  `/${encodeURIComponent(CUSTOMER)}` +
	  `/${encodeURIComponent(fullProfile.serviceId)}` +
	  `/externalnumbers/${encodeURIComponent(externalNumber)}/inboundcommshandling`;

	const r = await fetch(url, {
	  method: "GET",
	  headers: await orangeHeaders(fullProfile),
	});
	const text = await r.text();
	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API inbound rules error",
		status: r.status,
		body: text,
	  });
	}

	const item = text ? JSON.parse(text) : null;
	return res.json({ ok: true, item });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.put("/api/inbound-rules/:externalNumber", async (req, res) => {
  try {
	const externalNumber = String(req.params.externalNumber || "").replace(/\D/g, "");
	if (!externalNumber) {
	  return res.status(400).json({ ok: false, message: "Missing external number" });
	}

	const payload = req.body ?? {};
	const fullProfile = getFullProfile();
	const baseUri = fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`;
	const url =
	  `${baseUri}` +
	  `/${encodeURIComponent(CUSTOMER)}` +
	  `/${encodeURIComponent(fullProfile.serviceId)}` +
	  `/externalnumbers/${encodeURIComponent(externalNumber)}/inboundcommshandling`;

	const r = await fetch(url, {
	  method: "PUT",
	  headers: {
		...(await orangeHeaders(fullProfile)),
		"Content-Type": "application/json; charset=utf-8",
	  },
	  body: JSON.stringify(payload),
	});
	const text = await r.text();
	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API inbound rules update error",
		status: r.status,
		body: text,
	  });
	}

	const item = text ? JSON.parse(text) : payload;
	return res.json({ ok: true, item });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// GET list mirrored routes
app.get("/api/mirroredroutes", async (req, res) => {
  try {
	const status = req.query.status ?? "ACTIVE";
	const url =
	  `${ORANGE_API_BASE}` +
	  orangeBasePath() +
	  `/mirroredroutes?status=${encodeURIComponent(status)}`;

	const r = await fetch(url, {
	  method: "GET",
	  headers: await orangeHeaders(),
	});

	const text = await r.text();

	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API error",
		status: r.status,
		body: text,
	  });
	}

	const data = text ? JSON.parse(text) : [];
	return res.json({
	  ok: true,
	  items: Array.isArray(data) ? data : [],
	  meta: {
		resultCount: r.headers.get("x-result-count"),
		totalCount: r.headers.get("x-total-count"),
		requestId: r.headers.get("x-oapi-request-id") || r.headers.get("x-oapi-request-id"),
	  },
	});
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// GET agent contexts
app.get("/api/agent-contexts", async (_req, res) => {
  try {
	const fullProfile = getFullProfile();
	const url =
	  `${fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`}` +
	  `/contexts?status=ACTIVATED`;

	const r = await fetch(url, {
	  method: "GET",
	  headers: await orangeFullHeaders(),
	});

	const text = await r.text();

	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API agent contexts error",
		status: r.status,
		body: text,
	  });
	}

	const data = text ? JSON.parse(text) : [];
	const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
	return res.json({ ok: true, items });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.get("/api/agent-contexts/:id/calls", async (req, res) => {
  try {
	const { id } = req.params;
	if (!id) {
	  return res.status(400).json({ ok: false, message: "Missing context id" });
	}

	const fullProfile = getFullProfile();
	const url =
	  `${fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`}` +
	  `/contexts/${encodeURIComponent(id)}/calls`;

	const r = await fetch(url, {
	  method: "GET",
	  headers: await orangeFullHeaders(),
	});

	const text = await r.text();
	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API context calls error",
		status: r.status,
		body: text,
	  });
	}

	const data = text ? JSON.parse(text) : [];
	const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
	return res.json({ ok: true, items });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.patch("/api/agent-contexts/:id", async (req, res) => {
  try {
	const { id } = req.params;
	const { note, ownerInfo, callConfirmation } = req.body ?? {};
	if (!id) {
	  return res.status(400).json({ ok: false, message: "Missing context id" });
	}

	const fullProfile = getFullProfile();
	const url =
	  `${fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`}` +
	  `/contexts/${encodeURIComponent(id)}`;

	const r = await fetch(url, {
	  method: "PATCH",
	  headers: {
		...(await orangeFullHeaders()),
		"Content-Type": "application/json; charset=utf-8",
	  },
	  body: JSON.stringify({ note, ownerInfo, callConfirmation }),
	});

	const text = await r.text();
	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API update context error",
		status: r.status,
		body: text,
	  });
	}

	const item = text ? JSON.parse(text) : null;
	return res.json({ ok: true, item });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.delete("/api/agent-contexts/:id", async (req, res) => {
  try {
	const { id } = req.params;
	if (!id) {
	  return res.status(400).json({ ok: false, message: "Missing context id" });
	}

	const fullProfile = getFullProfile();
	const url =
	  `${fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`}` +
	  `/contexts/${encodeURIComponent(id)}`;

	const r = await fetch(url, {
	  method: "DELETE",
	  headers: await orangeFullHeaders(),
	});

	const text = await r.text();
	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API delete context error",
		status: r.status,
		body: text,
	  });
	}

	return res.status(204).end();
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post("/api/agent-contexts", async (req, res) => {
  try {
	const {
	  aliasNumber,
	  capabilities,
	  selectAnUnassignedNumber,
	  smsNotificationEmail,
	  userNumber,
	  note,
	  ownerInfo,
	  callConfirmation,
	} = req.body ?? {};

	if (!userNumber) {
	  return res.status(400).json({ ok: false, message: "Missing userNumber" });
	}

	const fullProfile = getFullProfile();
	const url =
	  `${fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`}` +
	  `/contexts`;

	const r = await fetch(url, {
	  method: "POST",
	  headers: {
		...(await orangeFullHeaders()),
		"Content-Type": "application/json; charset=utf-8",
	  },
	  body: JSON.stringify({
		aliasNumber,
		capabilities,
		selectAnUnassignedNumber,
		smsNotificationEmail,
		userNumber,
		note,
		ownerInfo,
		callConfirmation,
	  }),
	});

	const text = await r.text();
	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API create context error",
		status: r.status,
		body: text,
	  });
	}

	const item = text ? JSON.parse(text) : null;
	return res.status(201).json({ ok: true, item });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post("/api/agent-contexts/:id/click-to-call", async (req, res) => {
  try {
	const { id } = req.params;
	const number = String(req.query.number || "").trim();
	const note = String(req.body?.note || "Appel lors d'une intervention client");

	if (!id) {
	  return res.status(400).json({ ok: false, message: "Missing context id" });
	}
	if (!number) {
	  return res.status(400).json({ ok: false, message: "Missing number query parameter" });
	}

	const fullProfile = getFullProfile();
	const url =
	  `${fullProfile.baseUri || `${ORANGE_API_BASE}/alias-numbers-full/v4/${encodeURIComponent(REGION)}`}` +
	  `/contexts/${encodeURIComponent(id)}/clickToCall?number=${encodeURIComponent(number)}`;

	const r = await fetch(url, {
	  method: "POST",
	  headers: {
		...(await orangeFullHeaders()),
		"Content-Type": "application/json; charset=utf-8",
	  },
	  body: JSON.stringify({ note }),
	});

	const text = await r.text();
	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API clickToCall error",
		status: r.status,
		body: text,
	  });
	}

	const item = text ? JSON.parse(text) : null;
	return res.json({ ok: true, item });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// POST create mirrored route
app.post("/api/mirroredroutes", async (req, res) => {
  try {
	const { aUserNumber, bUserNumber, endDate } = req.body ?? {};
	if (!aUserNumber || !bUserNumber) {
	  return res.status(400).json({ ok: false, message: "Missing aUserNumber or bUserNumber" });
	}

	const url =
	  `${ORANGE_API_BASE}` +
	  orangeBasePath() +
	  `/mirroredroutes?status=ACTIVE`;

	const r = await fetch(url, {
	  method: "POST",
	  headers: {
		...(await orangeHeaders()),
		"Content-Type": "application/json; charset=utf-8",
	  },
	  body: JSON.stringify({ aUserNumber, bUserNumber, endDate }),
	});

	const text = await r.text();

	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API create error",
		status: r.status,
		body: text,
	  });
	}

	const created = text ? JSON.parse(text) : null;
	return res.status(201).json({ ok: true, item: created });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// DELETE mirrored route by id (expects 204)
app.delete("/api/mirroredroutes/:id", async (req, res) => {
  try {
	const { id } = req.params;

	const url =
	  `${ORANGE_API_BASE}` +
	  orangeBasePath() +
	  `/mirroredroutes/${encodeURIComponent(id)}`;

	const r = await fetch(url, {
	  method: "DELETE",
	  headers: await orangeHeaders(),
	});

	if (r.status === 204) {
	  return res.status(204).send();
	}

	const text = await r.text();

	if (!r.ok) {
	  return res.status(r.status).json({
		ok: false,
		message: "Orange API delete error",
		status: r.status,
		body: text,
	  });
	}

	// fallback if API returns JSON
	let payload = null;
	try { payload = text ? JSON.parse(text) : null; } catch { payload = text || null; }
	return res.json({ ok: true, deletedId: id, response: payload });
  } catch (e) {
	return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy ready on http://localhost:${PORT}`);
});
