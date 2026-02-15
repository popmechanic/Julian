const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─── Fake JWT parts (base64url encoded) ───
const FAKE_JWT_HEADER = btoa(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "clerk-key-abc123" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const FAKE_JWT_PAYLOAD = btoa(JSON.stringify({
  sub: "user_2xK9mL",
  iss: "https://internal-dingo-28.clerk.accounts.dev",
  iat: Math.floor(Date.now() / 1000) - 300,
  exp: Math.floor(Date.now() / 1000) + 3300,
  name: "Marcus Estes",
  email: "marcus@example.com",
  azp: "julian.exe.xyz"
})).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const FAKE_JWT_SIGNATURE = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk_thcuN0eY-CxoRHvBJ8sMrnGsPYhp7PHecyOF9E_b2w";
const FAKE_JWT = `${FAKE_JWT_HEADER}.${FAKE_JWT_PAYLOAD}.${FAKE_JWT_SIGNATURE}`;

// ─── Section IDs and titles ───
const SECTIONS = [
  { id: "tokens", title: "Tokens", num: 1 },
  { id: "jwt", title: "JWT", num: 2 },
  { id: "headers", title: "Headers", num: 3 },
  { id: "bearer", title: "Bearer", num: 4 },
  { id: "flow", title: "Auth Flow", num: 5 },
  { id: "verify", title: "Verification", num: 6 },
  { id: "ssl", title: "SSL", num: 7 },
  { id: "workaround", title: "X-Auth", num: 8 },
];

// ─── Progress indicator ───
function ProgressNav({ active }) {
  return (
    <nav style={{
      position: "fixed", right: 24, top: "50%", transform: "translateY(-50%)",
      display: "flex", flexDirection: "column", gap: 8, zIndex: 100,
    }}>
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          title={s.title}
          style={{
            width: 10, height: 10, borderRadius: "50%",
            background: active === s.id ? "#f97316" : "rgba(255,255,255,0.15)",
            border: active === s.id ? "2px solid #fb923c" : "2px solid rgba(255,255,255,0.08)",
            transition: "all 0.3s",
            display: "block",
          }}
        />
      ))}
    </nav>
  );
}

// ─── Reusable section wrapper ───
function Section({ id, num, title, subtitle, children }) {
  return (
    <section
      id={id}
      style={{
        minHeight: "100vh",
        display: "flex", flexDirection: "column", justifyContent: "center",
        padding: "80px 24px",
        maxWidth: 780, margin: "0 auto",
      }}
    >
      <div style={{ marginBottom: 12, color: "#f97316", fontFamily: "JetBrains Mono, monospace", fontSize: 13, letterSpacing: 2 }}>
        PART {num}
      </div>
      <h2 style={{ fontSize: "clamp(28px, 5vw, 42px)", fontWeight: 700, margin: "0 0 8px", lineHeight: 1.15 }}>
        {title}
      </h2>
      {subtitle && (
        <p style={{ fontSize: 17, color: "#94a3b8", margin: "0 0 40px", lineHeight: 1.6 }}>{subtitle}</p>
      )}
      <div style={{ fontSize: 16, lineHeight: 1.75, color: "#cbd5e1" }}>
        {children}
      </div>
    </section>
  );
}

// ─── Code block helper ───
function Code({ children, style }) {
  return (
    <pre style={{
      background: "#0f172a", border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 10, padding: "20px 24px", overflowX: "auto",
      fontFamily: "JetBrains Mono, monospace", fontSize: 13.5, lineHeight: 1.7,
      margin: "20px 0", color: "#e2e8f0", ...style,
    }}>
      {children}
    </pre>
  );
}

// ─── Callout box ───
function Callout({ emoji, children }) {
  return (
    <div style={{
      background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.15)",
      borderRadius: 10, padding: "16px 20px", margin: "20px 0",
      display: "flex", gap: 14, alignItems: "flex-start",
    }}>
      <span style={{ fontSize: 22, flexShrink: 0, lineHeight: 1.5 }}>{emoji}</span>
      <div style={{ lineHeight: 1.65 }}>{children}</div>
    </div>
  );
}

// ─── Interactive button ───
function Btn({ onClick, children, active, style }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "#f97316" : "rgba(255,255,255,0.06)",
        color: active ? "#0f172a" : "#e2e8f0",
        border: "1px solid " + (active ? "#f97316" : "rgba(255,255,255,0.1)"),
        borderRadius: 8, padding: "8px 18px", cursor: "pointer",
        fontFamily: "Inter, sans-serif", fontSize: 14, fontWeight: 500,
        transition: "all 0.2s", ...style,
      }}
    >
      {children}
    </button>
  );
}

// ════════════════════════════════════════
// SECTION 1: What is a Token?
// ════════════════════════════════════════
function TokenSection() {
  const [name, setName] = useState("Marcus");
  const [role, setRole] = useState("admin");
  const token = btoa(JSON.stringify({ name, role, issued: new Date().toISOString().slice(0, 19) }));

  return (
    <Section id="tokens" num={1} title="What is a Token?" subtitle="The simplest idea in auth: proving who you are without saying your password every time.">
      <p>
        Imagine you walk up to a concert venue. You show your ticket at the door, they check your name against the list,
        and they slap a <strong style={{ color: "#f97316" }}>wristband</strong> on you. From that point on, nobody asks
        for your ticket again. The wristband <em>is</em> your proof. You flash it at the bar, at the VIP section, at the
        merch table. Everyone trusts the wristband.
      </p>
      <p style={{ marginTop: 16 }}>
        A <strong>token</strong> is the digital version of that wristband. When you log in to a website, the server checks your
        password <em>once</em>, then hands you back a token — a long string of characters. Your browser stores it and sends
        it along with every future request. The server sees the token and knows who you are without checking your password again.
      </p>

      <Callout emoji="&#127915;">
        <strong>Token = wristband.</strong> You prove your identity once (password), then carry a lightweight proof (token) for everything after.
      </Callout>

      <p style={{ marginTop: 24, marginBottom: 12, fontWeight: 600, color: "#f8fafc" }}>Try it: build a simple token</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#94a3b8" }}>
          Name
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={{
              background: "#0f172a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6,
              padding: "8px 12px", color: "#e2e8f0", fontFamily: "JetBrains Mono, monospace", fontSize: 14, width: 160,
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#94a3b8" }}>
          Role
          <select
            value={role}
            onChange={e => setRole(e.target.value)}
            style={{
              background: "#0f172a", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6,
              padding: "8px 12px", color: "#e2e8f0", fontFamily: "Inter, sans-serif", fontSize: 14,
            }}
          >
            <option value="admin">admin</option>
            <option value="user">user</option>
            <option value="guest">guest</option>
          </select>
        </label>
      </div>
      <Code>
        <span style={{ color: "#64748b" }}>// Your identity, encoded as a base64 string:</span>{"\n"}
        <span style={{ color: "#f97316", wordBreak: "break-all" }}>{token}</span>{"\n\n"}
        <span style={{ color: "#64748b" }}>// Which decodes to:</span>{"\n"}
        <span style={{ color: "#a5f3fc" }}>{JSON.stringify({ name, role, issued: new Date().toISOString().slice(0, 19) }, null, 2)}</span>
      </Code>
      <p style={{ fontSize: 14, color: "#64748b" }}>
        This is just base64 — anyone can decode it. That's the problem a JWT solves. Keep scrolling.
      </p>
    </Section>
  );
}

// ════════════════════════════════════════
// SECTION 2: What is a JWT?
// ════════════════════════════════════════
function JWTSection() {
  const [selected, setSelected] = useState(null);

  const parts = [
    {
      label: "Header", color: "#ef4444", segment: FAKE_JWT_HEADER,
      decoded: JSON.stringify({ alg: "RS256", typ: "JWT", kid: "clerk-key-abc123" }, null, 2),
      explain: "The header says what algorithm was used to sign this token. RS256 means RSA with SHA-256 — asymmetric crypto. The 'kid' (key ID) tells the server which public key to use for verification.",
    },
    {
      label: "Payload", color: "#a855f7", segment: FAKE_JWT_PAYLOAD,
      decoded: JSON.stringify({
        sub: "user_2xK9mL",
        iss: "https://internal-dingo-28.clerk.accounts.dev",
        iat: "1739500000 (when it was issued)",
        exp: "1739503600 (when it expires)",
        name: "Marcus Estes",
        email: "marcus@example.com",
        azp: "julian.exe.xyz",
      }, null, 2),
      explain: "The payload is your identity — who you are, who issued the token, when it expires. 'sub' is your user ID. 'iss' is the issuer (Clerk). 'exp' is the expiration timestamp. All of this is readable by anyone — it's just base64, not encrypted.",
    },
    {
      label: "Signature", color: "#22c55e", segment: FAKE_JWT_SIGNATURE,
      decoded: "(binary cryptographic signature — not human-readable)",
      explain: "The signature is what makes a JWT trustworthy. The issuer takes the header + payload, hashes them with SHA-256, then signs the hash with their private key. The server can verify this signature using the issuer's public key. If anyone changes even one character in the header or payload, the signature won't match, and the server rejects the token.",
    },
  ];

  return (
    <Section id="jwt" num={2} title="What is a JWT?" subtitle="A JSON Web Token: three pieces separated by dots. Click each piece to see inside.">
      <p>
        JWT stands for <strong>JSON Web Token</strong> (pronounced "jot"). It's a specific <em>format</em> for tokens
        that solves the problem from Part 1: how does the server know the token hasn't been tampered with?
      </p>
      <p style={{ marginTop: 12 }}>A JWT has three parts, separated by dots:</p>

      {/* Interactive JWT string */}
      <div style={{
        background: "#0f172a", borderRadius: 12, padding: 24, margin: "24px 0",
        border: "1px solid rgba(255,255,255,0.06)", overflowX: "auto",
      }}>
        <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 14, wordBreak: "break-all", lineHeight: 2 }}>
          {parts.map((p, i) => (
            <React.Fragment key={p.label}>
              {i > 0 && <span style={{ color: "#475569" }}>.</span>}
              <span
                onClick={() => setSelected(selected === i ? null : i)}
                style={{
                  color: selected === i ? p.color : (selected === null ? p.color : "#334155"),
                  cursor: "pointer",
                  textDecoration: selected === i ? "underline" : "none",
                  textDecorationColor: p.color,
                  textUnderlineOffset: 4,
                  transition: "all 0.3s",
                  filter: selected !== null && selected !== i ? "brightness(0.4)" : "none",
                }}
              >
                {p.segment}
              </span>
            </React.Fragment>
          ))}
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 16 }}>
          {parts.map((p, i) => (
            <span
              key={p.label}
              onClick={() => setSelected(selected === i ? null : i)}
              style={{
                fontSize: 12, fontWeight: 600, color: p.color, cursor: "pointer",
                opacity: selected !== null && selected !== i ? 0.3 : 1,
                transition: "opacity 0.3s", fontFamily: "JetBrains Mono, monospace",
              }}
            >
              {p.label}
            </span>
          ))}
        </div>
      </div>

      {/* Decoded view */}
      {selected !== null && (
        <div style={{
          background: `${parts[selected].color}08`,
          border: `1px solid ${parts[selected].color}30`,
          borderRadius: 12, padding: 24, margin: "0 0 24px",
          animation: "fadeIn 0.3s ease",
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: parts[selected].color, marginBottom: 8 }}>
            {parts[selected].label} — decoded
          </div>
          <Code style={{ margin: "12px 0", fontSize: 13 }}>
            {parts[selected].decoded}
          </Code>
          <p style={{ fontSize: 14, color: "#94a3b8", margin: 0, lineHeight: 1.65 }}>
            {parts[selected].explain}
          </p>
        </div>
      )}

      <Callout emoji="&#128273;">
        The key insight: the header and payload are <strong>not encrypted</strong> — anyone can read them. The <span style={{ color: "#22c55e" }}>signature</span> just proves they haven't been changed since the issuer created the token.
      </Callout>
    </Section>
  );
}

// ════════════════════════════════════════
// SECTION 3: HTTP Headers
// ════════════════════════════════════════
function HeadersSection() {
  const [headers, setHeaders] = useState({
    "Content-Type": true,
    "Authorization": true,
    "Accept": false,
    "User-Agent": false,
  });

  const headerValues = {
    "Content-Type": "application/json",
    "Authorization": "Bearer eyJhbGciOi...",
    "Accept": "text/html, application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; ...)",
  };

  const toggle = (key) => setHeaders(h => ({ ...h, [key]: !h[key] }));

  return (
    <Section id="headers" num={3} title="What are HTTP Headers?" subtitle="Every web request is like a letter. Headers are what's written on the envelope.">
      <p>
        When your browser talks to a server, it sends an <strong>HTTP request</strong>. Think of it like mailing a letter.
        The letter itself (the <em>body</em>) is the content — a form submission, a JSON message, whatever. But the
        <strong style={{ color: "#f97316" }}> envelope</strong> has metadata written on it: who it's from, what language it's in,
        what format the contents are.
      </p>
      <p style={{ marginTop: 12 }}>
        These metadata fields are called <strong>headers</strong>. They're key-value pairs sent <em>before</em> the body.
        The server reads them to understand the request before it even looks at the content.
      </p>

      <p style={{ marginTop: 28, marginBottom: 12, fontWeight: 600, color: "#f8fafc" }}>Toggle headers on/off to see how a request changes:</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {Object.keys(headers).map(h => (
          <Btn key={h} active={headers[h]} onClick={() => toggle(h)}>
            {headers[h] ? "\u2713 " : ""}{h}
          </Btn>
        ))}
      </div>

      <Code>
        <span style={{ color: "#22c55e" }}>POST</span> <span style={{ color: "#f8fafc" }}>/api/chat</span> <span style={{ color: "#64748b" }}>HTTP/1.1</span>{"\n"}
        <span style={{ color: "#64748b" }}>Host: julian.exe.xyz</span>{"\n"}
        {Object.entries(headers).filter(([, v]) => v).map(([k]) => (
          <React.Fragment key={k}>
            <span style={{ color: k === "Authorization" ? "#f97316" : "#93c5fd" }}>{k}</span>
            <span style={{ color: "#64748b" }}>: </span>
            <span style={{ color: "#e2e8f0" }}>{headerValues[k]}</span>{"\n"}
          </React.Fragment>
        ))}
        {"\n"}
        <span style={{ color: "#64748b" }}>{"{"} "message": "Hello, Julian" {"}"}</span>
      </Code>

      <Callout emoji="&#128236;">
        The <span style={{ color: "#f97316" }}>Authorization</span> header is just another envelope field — but it's the one that carries your token. That's how the server knows who's knocking.
      </Callout>
    </Section>
  );
}

// ════════════════════════════════════════
// SECTION 4: Bearer Token Pattern
// ════════════════════════════════════════
function BearerSection() {
  const [dropped, setDropped] = useState(false);

  return (
    <Section id="bearer" num={4} title="Bearer Authentication" subtitle="The word 'Bearer' just means: whoever bears this token, trust them.">
      <p>
        There are many ways to send auth info in a request — cookies, query parameters, custom headers.
        But the standard way for APIs is the <strong>Authorization header</strong> with a <strong>Bearer</strong> scheme:
      </p>
      <Code>
        Authorization: Bearer {"<"}your-jwt-token-here{">"}
      </Code>
      <p>
        "Bearer" literally means "the bearer of this token." It's a convention defined in{" "}
        <span style={{ color: "#94a3b8" }}>RFC 6750</span>. The server doesn't care <em>who</em> sent the request —
        if the token is valid, the request is authorized. Just like the concert wristband: whoever is wearing it gets in.
      </p>

      <p style={{ marginTop: 28, marginBottom: 12, fontWeight: 600, color: "#f8fafc" }}>
        Try it: click the token to place it in the header
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Token */}
        <div
          onClick={() => setDropped(!dropped)}
          style={{
            background: dropped ? "rgba(249,115,22,0.08)" : "#0f172a",
            border: `1px dashed ${dropped ? "#f9731640" : "#f97316"}`,
            borderRadius: 8, padding: "12px 16px", cursor: "pointer",
            fontFamily: "JetBrains Mono, monospace", fontSize: 12,
            color: dropped ? "#64748b" : "#f97316",
            textAlign: "center", transition: "all 0.4s",
            textDecoration: dropped ? "line-through" : "none",
          }}
        >
          {dropped ? "(token moved to header)" : "eyJhbGciOiJSUzI1NiIs... (click to use)"}
        </div>

        {/* Request */}
        <Code style={{
          borderColor: dropped ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.06)",
          transition: "border-color 0.4s",
        }}>
          <span style={{ color: "#22c55e" }}>POST</span> <span style={{ color: "#f8fafc" }}>/api/chat</span>{"\n"}
          <span style={{ color: "#93c5fd" }}>Content-Type</span><span style={{ color: "#64748b" }}>: application/json</span>{"\n"}
          <span style={{ color: "#f97316" }}>Authorization</span><span style={{ color: "#64748b" }}>: Bearer </span>
          {dropped ? (
            <span style={{ color: "#f97316", animation: "fadeIn 0.5s ease" }}>eyJhbGciOiJSUzI1NiIs...</span>
          ) : (
            <span style={{ color: "#334155" }}>____________</span>
          )}{"\n\n"}
          <span style={{ color: "#64748b" }}>{"{"} "message": "Hello" {"}"}</span>
        </Code>
      </div>

      {dropped && (
        <Callout emoji="&#9989;">
          That's the whole pattern. Every request from the browser includes this header. The server extracts the token after "Bearer ", decodes the JWT, verifies the signature, and now it knows you're <strong>user_2xK9mL</strong> (Marcus) without ever asking for a password.
        </Callout>
      )}
    </Section>
  );
}

// ════════════════════════════════════════
// SECTION 5: The Auth Flow
// ════════════════════════════════════════
function FlowSection() {
  const [step, setStep] = useState(0);

  const steps = [
    {
      title: "User opens the page",
      left: "Browser", right: "Server",
      arrow: "\u2192",
      detail: "GET / — the browser requests the page. No token yet. No identity.",
      leftIcon: "\uD83D\uDCBB", rightIcon: "\uD83C\uDF10",
    },
    {
      title: "User signs in via Clerk",
      left: "Browser", right: "Clerk",
      arrow: "\u2192",
      detail: "A modal pops up. The user enters their email and password (or uses OAuth). Clerk handles the authentication and returns a session.",
      leftIcon: "\uD83D\uDCBB", rightIcon: "\uD83D\uDD10",
    },
    {
      title: "Clerk issues a JWT",
      left: "Clerk", right: "Browser",
      arrow: "\u2192",
      detail: "Clerk signs a JWT with its private key and sends it to the browser. The payload contains the user's ID, email, and expiration time. The browser stores it in memory.",
      leftIcon: "\uD83D\uDD10", rightIcon: "\uD83D\uDCBB",
    },
    {
      title: "Browser makes an API call",
      left: "Browser", right: "Server",
      arrow: "\u2192",
      detail: "POST /api/chat with header: Authorization: Bearer eyJhb... — the token rides along with every request, like flashing your wristband.",
      leftIcon: "\uD83D\uDCBB", rightIcon: "\uD83C\uDF10",
    },
    {
      title: "Server verifies the JWT",
      left: "Server", right: "Clerk JWKS",
      arrow: "\u2192",
      detail: "The server fetches Clerk's public keys (JWKS endpoint), uses them to verify the token's signature, checks it hasn't expired, and extracts the user ID. All without contacting Clerk directly for each request.",
      leftIcon: "\uD83C\uDF10", rightIcon: "\uD83D\uDD11",
    },
    {
      title: "Server responds",
      left: "Server", right: "Browser",
      arrow: "\u2192",
      detail: "The request is authorized. The server processes it and returns the response. The user never shows their password again — the token does all the talking.",
      leftIcon: "\uD83C\uDF10", rightIcon: "\uD83D\uDCBB",
    },
  ];

  const s = steps[step];

  return (
    <Section id="flow" num={5} title="The Auth Flow" subtitle="Step through the full sequence, from opening the page to making authenticated requests.">
      {/* Step counter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
        {steps.map((_, i) => (
          <div
            key={i}
            onClick={() => setStep(i)}
            style={{
              flex: 1, height: 4, borderRadius: 2, cursor: "pointer",
              background: i <= step ? "#f97316" : "rgba(255,255,255,0.08)",
              transition: "background 0.3s",
            }}
          />
        ))}
      </div>

      {/* Flow visualization */}
      <div style={{
        background: "#0f172a", borderRadius: 16, padding: "32px 24px",
        border: "1px solid rgba(255,255,255,0.06)", textAlign: "center",
        minHeight: 220, display: "flex", flexDirection: "column", justifyContent: "center",
      }}>
        <div style={{ fontSize: 13, color: "#f97316", fontFamily: "JetBrains Mono, monospace", marginBottom: 8 }}>
          Step {step + 1} of {steps.length}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#f8fafc", marginBottom: 24 }}>
          {s.title}
        </div>

        {/* Actor diagram */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24, marginBottom: 24 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 36 }}>{s.leftIcon}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{s.left}</div>
          </div>
          <div style={{ fontSize: 28, color: "#f97316", animation: "pulse 1.5s ease infinite" }}>
            {s.arrow}
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 36 }}>{s.rightIcon}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{s.right}</div>
          </div>
        </div>

        <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.65, maxWidth: 500, margin: "0 auto" }}>
          {s.detail}
        </p>
      </div>

      {/* Nav buttons */}
      <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "center" }}>
        <Btn onClick={() => setStep(Math.max(0, step - 1))} style={{ opacity: step === 0 ? 0.3 : 1 }}>
          Back
        </Btn>
        <Btn onClick={() => setStep(Math.min(steps.length - 1, step + 1))} active={step < steps.length - 1}>
          {step < steps.length - 1 ? "Next Step" : "Done"}
        </Btn>
      </div>
    </Section>
  );
}

// ════════════════════════════════════════
// SECTION 6: JWT Verification
// ════════════════════════════════════════
function VerifySection() {
  const [mode, setMode] = useState(null); // "valid" | "tampered"
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState(null);

  const handleVerify = (type) => {
    setMode(type);
    setVerifying(true);
    setResult(null);
    setTimeout(() => {
      setVerifying(false);
      setResult(type === "valid" ? "pass" : "fail");
    }, 1500);
  };

  return (
    <Section id="verify" num={6} title="How the Server Verifies" subtitle="The signature check: the moment the server decides whether to trust you.">
      <p>
        When a JWT arrives, the server does three things:
      </p>
      <ol style={{ paddingLeft: 24, margin: "16px 0" }}>
        <li style={{ marginBottom: 8 }}>
          <strong>Decode the header</strong> to find the algorithm (<code style={{ color: "#ef4444" }}>RS256</code>) and key ID (<code style={{ color: "#ef4444" }}>kid</code>).
        </li>
        <li style={{ marginBottom: 8 }}>
          <strong>Fetch the public key</strong> from the issuer's <span style={{ color: "#a855f7" }}>JWKS endpoint</span> — a URL like{" "}
          <code style={{ color: "#94a3b8", fontSize: 13 }}>https://clerk.dev/.well-known/jwks.json</code> that publishes the public keys. The server caches these.
        </li>
        <li style={{ marginBottom: 8 }}>
          <strong>Verify the signature</strong>: take the header + payload, hash them, and check that the hash matches the signature using the public key. If it matches, the token is authentic. Then check <code style={{ color: "#a855f7" }}>exp</code> to make sure it hasn't expired.
        </li>
      </ol>

      <Callout emoji="&#128161;">
        <strong>Asymmetric crypto is the key insight.</strong> Clerk signs with a private key that only Clerk has. Your server verifies with a public key that anyone can have. The server never needs Clerk's secret — it just needs the public key.
      </Callout>

      <p style={{ marginTop: 28, marginBottom: 12, fontWeight: 600, color: "#f8fafc" }}>
        Try verifying two tokens:
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <Btn onClick={() => handleVerify("valid")} active={mode === "valid"}>
          Verify Valid Token
        </Btn>
        <Btn onClick={() => handleVerify("tampered")} active={mode === "tampered"}>
          Verify Tampered Token
        </Btn>
      </div>

      {mode && (
        <div style={{
          background: "#0f172a", borderRadius: 12, padding: 24,
          border: "1px solid rgba(255,255,255,0.06)",
          fontFamily: "JetBrains Mono, monospace", fontSize: 13,
        }}>
          <div style={{ color: "#64748b", marginBottom: 8 }}>
            {mode === "valid" ? "// Original token — untouched" : "// Token with payload modified (role changed to 'superadmin')"}
          </div>
          <div style={{ wordBreak: "break-all", lineHeight: 1.8, marginBottom: 16 }}>
            <span style={{ color: "#ef4444" }}>{FAKE_JWT_HEADER}</span>
            <span style={{ color: "#475569" }}>.</span>
            <span style={{ color: mode === "tampered" ? "#fbbf24" : "#a855f7" }}>
              {mode === "tampered"
                ? btoa(JSON.stringify({ sub: "user_2xK9mL", role: "superadmin", exp: 9999999999 })).replace(/=/g, "")
                : FAKE_JWT_PAYLOAD}
            </span>
            <span style={{ color: "#475569" }}>.</span>
            <span style={{ color: "#22c55e" }}>{FAKE_JWT_SIGNATURE}</span>
          </div>

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 16 }}>
            {verifying ? (
              <div style={{ color: "#f97316" }}>
                Verifying... SHA-256(header.payload) vs signature...
              </div>
            ) : result === "pass" ? (
              <div>
                <span style={{ color: "#22c55e", fontSize: 16 }}>PASS</span>
                <span style={{ color: "#94a3b8" }}> — Signature matches. Token is authentic. exp check: valid (not expired).</span>
              </div>
            ) : (
              <div>
                <span style={{ color: "#ef4444", fontSize: 16 }}>FAIL</span>
                <span style={{ color: "#94a3b8" }}> — Signature mismatch. SHA-256 of modified payload does not match the original signature. This token was tampered with. Request rejected.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ════════════════════════════════════════
// SECTION 7: SSL Termination
// ════════════════════════════════════════
function SSLSection() {
  const [layer, setLayer] = useState(0);

  const layers = [
    {
      label: "Your Browser",
      desc: "The request starts here, fully encrypted with TLS. Headers, body, everything — scrambled into ciphertext that only the destination can read.",
      color: "#22c55e",
      encrypted: true,
    },
    {
      label: "The Internet",
      desc: "Your encrypted request travels across networks, routers, ISPs. Nobody in the middle can read the headers or body. They can see the destination IP address, but not what you're sending.",
      color: "#22c55e",
      encrypted: true,
    },
    {
      label: "Edge Proxy (exe.dev at 44.254.50.18)",
      desc: "HERE is where SSL termination happens. The proxy has the SSL certificate, so it decrypts the request. Now it can read every header, every byte. It processes the request, and in Julian's case — it strips the Authorization header before forwarding.",
      color: "#ef4444",
      encrypted: false,
    },
    {
      label: "nginx (port 80)",
      desc: "The request arrives at nginx over plain HTTP (unencrypted, but on a private network). The Authorization header is GONE. nginx proxies /api/ routes to the Bun server.",
      color: "#f97316",
      encrypted: false,
    },
    {
      label: "Bun server (port 3847)",
      desc: "server.ts receives the request. It looks for the Authorization header... and it's not there. The proxy stripped it. The Clerk JWT that the browser sent? Lost in transit.",
      color: "#ef4444",
      encrypted: false,
    },
  ];

  return (
    <Section id="ssl" num={7} title="SSL Termination" subtitle="The invisible middleman that broke our auth — and why it exists.">
      <p>
        When you visit <code style={{ color: "#94a3b8" }}>https://</code>julian.exe.xyz, the <strong>S</strong> in HTTPS means your
        connection is encrypted with TLS (Transport Layer Security, the successor to SSL). Everything — the URL path, the headers,
        the body — is encrypted in transit. Nobody between your browser and the server can read it.
      </p>
      <p style={{ marginTop: 12 }}>
        But <em>someone</em> has to decrypt it. In a simple setup, your web server does it directly. But in production, there's often
        a <strong>reverse proxy</strong> or <strong>load balancer</strong> sitting in front of your server. It holds the SSL certificate,
        decrypts the traffic, and forwards the plain HTTP request to your actual server. This is called <strong style={{ color: "#f97316" }}>SSL termination</strong>.
      </p>

      <p style={{ marginTop: 28, marginBottom: 12, fontWeight: 600, color: "#f8fafc" }}>
        Click through each layer of the request:
      </p>

      {/* Layer selector */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, flexWrap: "wrap" }}>
        {layers.map((l, i) => (
          <Btn key={i} onClick={() => setLayer(i)} active={layer === i} style={{ fontSize: 12, padding: "6px 12px" }}>
            {i + 1}. {l.label.split("(")[0].trim()}
          </Btn>
        ))}
      </div>

      {/* Visualization */}
      <div style={{
        background: "#0f172a", borderRadius: 16, padding: 28,
        border: `1px solid ${layers[layer].color}30`,
        transition: "border-color 0.3s",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 10, height: 10, borderRadius: "50%",
            background: layers[layer].encrypted ? "#22c55e" : "#ef4444",
          }} />
          <span style={{ fontSize: 13, fontFamily: "JetBrains Mono, monospace", color: layers[layer].encrypted ? "#22c55e" : "#ef4444" }}>
            {layers[layer].encrypted ? "ENCRYPTED" : "DECRYPTED"}
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#f8fafc" }}>
            {layers[layer].label}
          </span>
        </div>

        {/* Mock request view */}
        <Code style={{ margin: "12px 0", fontSize: 12.5 }}>
          {layers[layer].encrypted ? (
            <>
              <span style={{ color: "#22c55e" }}>TLS 1.3 encrypted payload:</span>{"\n"}
              <span style={{ color: "#334155" }}>
                a7:3f:9b:c2:41:e8:7d:0a:f5:62:1c:b8:d4:93:a0:5e{"\n"}
                8c:27:f1:6d:3a:e9:50:b4:c8:72:1f:a6:d3:09:e5:4b{"\n"}
                {"(headers, body, everything — unreadable)"}{"\n"}
              </span>
            </>
          ) : (
            <>
              <span style={{ color: "#22c55e" }}>POST</span> /api/chat HTTP/1.1{"\n"}
              <span style={{ color: "#93c5fd" }}>Content-Type</span>: application/json{"\n"}
              {layer >= 3 ? (
                <span style={{ color: "#ef4444", fontStyle: "italic" }}>
                  {"// Authorization header is GONE — stripped by the proxy"}{"\n"}
                </span>
              ) : (
                <>
                  <span style={{ color: "#f97316" }}>Authorization</span>: Bearer eyJhbGciOi...{"\n"}
                </>
              )}
              <span style={{ color: "#93c5fd" }}>X-Authorization</span>: Bearer eyJhbGciOi...{"\n"}
              {"\n"}
              <span style={{ color: "#64748b" }}>{"{"} "message": "Hello" {"}"}</span>
            </>
          )}
        </Code>

        <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.65, margin: 0 }}>
          {layers[layer].desc}
        </p>
      </div>
    </Section>
  );
}

// ════════════════════════════════════════
// SECTION 8: The X-Authorization Workaround
// ════════════════════════════════════════
function WorkaroundSection() {
  const [showSolution, setShowSolution] = useState(false);

  return (
    <Section id="workaround" num={8} title="The X-Authorization Workaround" subtitle="How Julian solves the stripped-header problem with one extra line of code.">
      <p>
        So here's the problem: the exe.dev edge proxy terminates SSL and strips the <code style={{ color: "#f97316" }}>Authorization</code> header
        before forwarding to nginx. This is common behavior for reverse proxies — some strip it for security reasons, some for configuration reasons.
        The result: our Clerk JWT never arrives at the Bun server.
      </p>
      <p style={{ marginTop: 12 }}>
        But the proxy only strips <em>standard</em> auth headers. Custom headers with an <code>X-</code> prefix pass through untouched.
      </p>

      <div style={{ textAlign: "center", margin: "32px 0" }}>
        <Btn onClick={() => setShowSolution(true)} active={showSolution}>
          {showSolution ? "The Fix" : "Show the solution"}
        </Btn>
      </div>

      {showSolution && (
        <>
          <p style={{ fontWeight: 600, color: "#f8fafc", marginBottom: 8 }}>On the frontend — send both headers:</p>
          <Code>
            <span style={{ color: "#64748b" }}>{"// getAuthHeaders() in index.html"}</span>{"\n"}
            <span style={{ color: "#c084fc" }}>const</span> token = <span style={{ color: "#c084fc" }}>await</span> window.Clerk.session.getToken();{"\n"}
            <span style={{ color: "#c084fc" }}>return</span> {"{"}{"\n"}
            {"  "}<span style={{ color: "#ef4444", textDecoration: "line-through" }}>'Authorization'</span>: <span style={{ color: "#a5f3fc" }}>{"`Bearer ${token}`"}</span>,       <span style={{ color: "#64748b" }}>{"// standard — gets stripped"}</span>{"\n"}
            {"  "}<span style={{ color: "#22c55e" }}>'X-Authorization'</span>: <span style={{ color: "#a5f3fc" }}>{"`Bearer ${token}`"}</span>,     <span style={{ color: "#64748b" }}>{"// custom — passes through"}</span>{"\n"}
            {"}"};
          </Code>

          <p style={{ fontWeight: 600, color: "#f8fafc", marginBottom: 8, marginTop: 24 }}>On the server — check both:</p>
          <Code>
            <span style={{ color: "#64748b" }}>{"// verifyClerkToken() in server.ts"}</span>{"\n"}
            <span style={{ color: "#c084fc" }}>const</span> auth = req.headers.get(<span style={{ color: "#a5f3fc" }}>"Authorization"</span>){"\n"}
            {"              "}|| req.headers.get(<span style={{ color: "#22c55e" }}>"X-Authorization"</span>);{"\n\n"}
            <span style={{ color: "#64748b" }}>{"// If either header has the token, we're good."}</span>{"\n"}
            <span style={{ color: "#64748b" }}>{"// In production, Authorization is stripped \u2192 X-Authorization wins."}</span>{"\n"}
            <span style={{ color: "#64748b" }}>{"// In local dev, Authorization works directly."}</span>
          </Code>

          <Callout emoji="&#127919;">
            <strong>That's it.</strong> Two lines of code — one on each side. The browser sends the token twice, the server checks both,
            and the proxy's header-stripping becomes invisible. The same code works in local dev (where <code>Authorization</code> isn't stripped) and in production (where <code>X-Authorization</code> carries it through).
          </Callout>

          {/* Full picture summary */}
          <div style={{
            background: "#0f172a", borderRadius: 16, padding: 28, marginTop: 32,
            border: "1px solid rgba(249,115,22,0.15)",
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#f8fafc", marginBottom: 20, textAlign: "center" }}>
              The Complete Picture
            </div>
            <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 13, lineHeight: 2.2, color: "#94a3b8" }}>
              <div><span style={{ color: "#a855f7" }}>1.</span> User signs in via <span style={{ color: "#f8fafc" }}>Clerk</span> {"\u2192"} gets a <span style={{ color: "#ef4444" }}>JWT</span></div>
              <div><span style={{ color: "#a855f7" }}>2.</span> Browser stores the JWT, sends it as <span style={{ color: "#f97316" }}>Authorization</span> + <span style={{ color: "#22c55e" }}>X-Authorization</span></div>
              <div><span style={{ color: "#a855f7" }}>3.</span> Request is <span style={{ color: "#22c55e" }}>TLS-encrypted</span> from browser to edge proxy</div>
              <div><span style={{ color: "#a855f7" }}>4.</span> Edge proxy <span style={{ color: "#ef4444" }}>terminates SSL</span>, strips <span style={{ color: "#ef4444", textDecoration: "line-through" }}>Authorization</span>, forwards to nginx</div>
              <div><span style={{ color: "#a855f7" }}>5.</span> nginx proxies <code>/api/</code> to Bun — <span style={{ color: "#22c55e" }}>X-Authorization</span> still intact</div>
              <div><span style={{ color: "#a855f7" }}>6.</span> server.ts reads <span style={{ color: "#22c55e" }}>X-Authorization</span>, verifies JWT with Clerk's <span style={{ color: "#a855f7" }}>JWKS</span> public keys</div>
              <div><span style={{ color: "#a855f7" }}>7.</span> Token valid {"\u2192"} request authorized {"\u2192"} Claude subprocess receives the message</div>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

// ════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════
export default function App() {
  const [active, setActive] = useState("tokens");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(e => {
          if (e.isIntersecting && e.intersectionRatio > 0.3) {
            setActive(e.target.id);
          }
        });
      },
      { threshold: [0.3] }
    );
    SECTIONS.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0c0f1a",
      color: "#e2e8f0",
      fontFamily: "Inter, system-ui, sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; }
        html { scroll-behavior: smooth; }
        code { font-family: JetBrains Mono, monospace; font-size: 0.9em; background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; }
        ::selection { background: #f9731640; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>

      <ProgressNav active={active} />

      {/* Hero */}
      <header style={{
        minHeight: "70vh", display: "flex", flexDirection: "column",
        justifyContent: "center", alignItems: "center", textAlign: "center",
        padding: "40px 24px",
      }}>
        <div style={{ fontSize: 13, color: "#f97316", fontFamily: "JetBrains Mono, monospace", letterSpacing: 3, marginBottom: 20 }}>
          AN INTERACTIVE GUIDE
        </div>
        <h1 style={{ fontSize: "clamp(36px, 7vw, 64px)", fontWeight: 700, lineHeight: 1.1, maxWidth: 700 }}>
          How JWT Authorization<br />Actually Works
        </h1>
        <p style={{ fontSize: 18, color: "#64748b", marginTop: 20, maxWidth: 500, lineHeight: 1.6 }}>
          From tokens to headers to SSL termination — everything you need to understand the auth system we built for Julian.
        </p>
        <div style={{ marginTop: 40, color: "#334155", fontSize: 24, animation: "pulse 2s ease infinite" }}>
          {"\u2193"}
        </div>
      </header>

      <TokenSection />
      <JWTSection />
      <HeadersSection />
      <BearerSection />
      <FlowSection />
      <VerifySection />
      <SSLSection />
      <WorkaroundSection />

      {/* Footer */}
      <footer style={{
        textAlign: "center", padding: "80px 24px",
        color: "#334155", fontSize: 14,
        borderTop: "1px solid rgba(255,255,255,0.04)",
      }}>
        Built for Marcus by Julian — February 2026
      </footer>
    </div>
  );
}
