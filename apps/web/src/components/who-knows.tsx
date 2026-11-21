import { Card } from "./kit";
import { useApi } from "../hooks";
import { href } from "../router";

interface Expert {
  user_id: string;
  name: string;
  email: string | null;
  score: number;
  topics: string[];
  online_sessions: string[];
}

/**
 * Who knows this: the people who wrote, reviewed, answered and documented most about a project, repository or topic
 * (rebuilt nightly, recent work counting most), with their online sessions and a way to ask.
 */
export function WhoKnows({ project, component, topic }: { project?: string; component?: string | null; topic?: string }) {
  const q = new URLSearchParams();
  if (project) q.set("project", project);
  if (component) q.set("component", component);
  if (topic) q.set("topic", topic);
  const { data } = useApi<{ topic: string; experts: Expert[] }>(`/experts?${q}`);
  if (!data || !data.experts.length) return null;
  return (
    <Card title="Who knows this" padding="sm" className="who-knows">
      <ul className="plain">
        {data.experts.map((e) => (
          <li key={e.user_id}>
            <strong>{e.name}</strong>
            {e.online_sessions.length > 0 && <span className="who-online" title={e.online_sessions.join(", ")}> · online</span>}
            <div className="small muted">{e.topics.slice(0, 3).join(", ")}</div>
            <a className="small" href={href("/sessions", { to: e.online_sessions[0] ?? e.email ?? "" })}>
              Ask
            </a>
          </li>
        ))}
      </ul>
      <p className="small muted">From what they wrote, reviewed, answered and documented; recent work counts most.</p>
    </Card>
  );
}
