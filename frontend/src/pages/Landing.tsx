import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import ForestScene from "../components/ForestScene";

const STEPS = [
  {
    t: "Record in the field",
    d: "Rangers log nests, sightings, camera-trap photos and human pressure on their phones, even without signal.",
  },
  {
    t: "Validate",
    d: "Specialists check each record before it counts. Unverified data never moves a trend.",
  },
  {
    t: "Detect change",
    d: "Encounter rates, forest loss and ecosystem indicators are tracked per landscape, with stated uncertainty.",
  },
  {
    t: "Act early",
    d: "Alerts reach the right people, become field tasks, and every decision is recorded.",
  },
];

const INDICATORS = [
  {
    k: "Population",
    lv: "high",
    d: "Chimpanzee encounter-rate trend from verified survey data",
  },
  {
    k: "Habitat",
    lv: "high",
    d: "Forest loss, fragmentation and mapped pressures",
  },
  {
    k: "Biodiversity",
    lv: "medium",
    d: "Camera-trap species richness over time",
  },
  {
    k: "Ecosystem",
    lv: "medium",
    d: "Vegetation, water quality and soil erosion",
  },
  {
    k: "Food security",
    lv: "low",
    d: "District context, never blamed on chimpanzee decline",
  },
];

export default function Landing() {
  const { user } = useAuth();
  if (user) return <Navigate to="/" replace />;
  return (
    <div className="landing">
      <header className="land-nav">
        <Link to="/welcome" className="land-brand">
          <img src="/icon.svg" alt="" width={30} height={30} />
          <span>CHIMP-WATCH AI</span>
        </Link>
        <nav className="row">
          <Link to="/login" className="btn ghost land-ghost">
            Sign in
          </Link>
          <Link to="/signup" className="btn primary">
            Sign up
          </Link>
        </nav>
      </header>

      <section className="land-hero">
        <ForestScene variant="hero" />
        <div className="land-hero-inner">
          <span className="land-kicker">
            <i />
            Sierra Leone pilot · West African chimpanzee
          </span>
          <h1>
            See where the forest is changing, before it's too late to act.
          </h1>
          <p>
            Chimpanzee monitoring, habitat change and ecosystem early warning
            for West Africa's protected landscapes. Built with rangers,
            researchers and protected-area authorities.
          </p>
          <div className="row" style={{ marginTop: 28 }}>
            <Link to="/signup" className="btn primary land-cta">
              Create an account
            </Link>
            <Link to="/login" className="btn land-cta land-outline">
              Sign in
            </Link>
          </div>
          <p className="land-small">
            Sign up with Google, Apple, GitHub or your email. New accounts are
            reviewed before they can see any data.
          </p>
        </div>
      </section>

      <section className="land-facts" aria-label="Why it matters">
        <div className="land-facts-inner">
          <div>
            <span className="v">Critically Endangered</span>
            <span className="l">
              The western chimpanzee's status on the IUCN Red List.
            </span>
          </div>
          <div>
            <span className="v">80%</span>
            <span className="l">
              Estimated decline in western chimpanzee numbers between 1990 and
              2014.
            </span>
            <div className="src">
              Kühl et al., 2017, via{" "}
              <a
                href="https://news.mongabay.com/2017/07/western-chimpanzee-numbers-declined-by-more-than-80-percent-over-the-past-quarter-century/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Mongabay
              </a>
            </div>
          </div>
          <div>
            <span className="v">~53,000</span>
            <span className="l">
              Western chimpanzees estimated to remain, with Sierra Leone among
              their strongholds.
            </span>
            <div className="src">
              2019 estimate, via{" "}
              <a
                href="https://news.mongabay.com/2019/05/western-chimp-numbers-revised-up-to-53000-but-development-threats-loom/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Mongabay
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="land-section">
        <h2>From a nest count to a decision</h2>
        <ol className="land-steps">
          {STEPS.map((s) => (
            <li key={s.t}>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="land-section land-split">
        <div>
          <h2>Five indicators, kept separate</h2>
          <p className="land-lead">
            Each landscape is scored on five indicators. They are never blended
            into one number, so you can always see what is driving concern and
            how confident the evidence is.
          </p>
        </div>
        <div
          className="land-indicators"
          aria-label="Example indicator strip for one landscape"
        >
          <div className="strip lg" aria-hidden="true">
            {INDICATORS.map((i) => (
              <span
                key={i.k}
                className={`${i.lv} ${i.k === "Food security" ? "ctx" : ""}`}
              />
            ))}
          </div>
          <ul>
            {INDICATORS.map((i) => (
              <li key={i.k}>
                <span className={`level ${i.lv}`}>
                  {i.lv[0].toUpperCase() + i.lv.slice(1)}
                </span>
                <b>{i.k}</b>
                <span className="muted">{i.d}</span>
              </li>
            ))}
          </ul>
          <p className="xs muted">
            Example only. Illustrates how one landscape's indicators appear.
          </p>
        </div>
      </section>

      <section className="land-section">
        <h2>Built for sensitive data</h2>
        <div className="land-trust">
          <div>
            <h3>Approved access only</h3>
            <p>
              Anyone can request an account. An administrator assigns each
              person to an organisation and role before they see anything.
            </p>
          </div>
          <div>
            <h3>Protected locations</h3>
            <p>
              Precise chimpanzee sites are blurred to about 11 km for everyone
              without explicit permission, including in exports and reports.
            </p>
          </div>
          <div>
            <h3>A full audit trail</h3>
            <p>
              Sign-ins, validations, exports and alert decisions are all
              recorded, so data use is accountable.
            </p>
          </div>
        </div>
      </section>

      <section className="land-cta-band">
        <ForestScene variant="band" />
        <div>
          <h2>Working on a monitored landscape?</h2>
          <p>
            Request access with the account you already use. Your organisation's
            administrator will confirm your role.
          </p>
          <div
            className="row"
            style={{ justifyContent: "center", marginTop: 22 }}
          >
            <Link to="/signup" className="btn primary land-cta">
              Create an account
            </Link>
            <Link to="/login" className="btn land-cta land-outline">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <footer className="land-foot">
        <span>
          CHIMP-WATCH AI · Chimpanzee conservation and ecosystem early warning
        </span>
        <span>
          Outputs are decision-support evidence and do not replace field surveys
          or expert judgement.
        </span>
      </footer>
    </div>
  );
}
