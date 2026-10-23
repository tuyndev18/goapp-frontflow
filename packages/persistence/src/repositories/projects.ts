import { hashJson, type Project, type ProjectProfile } from "@frontflow/domain";
import type { SqlDriver, SqlRow } from "../driver.js";
import { nowIso, num, str } from "../sql.js";

export class ProjectRepository {
  constructor(private readonly db: SqlDriver) {}

  upsert(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, last_opened_at)
         VALUES (@id, @name, @rootPath, @createdAt, @lastOpenedAt)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path,
           last_opened_at = excluded.last_opened_at`,
      )
      .run({
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        createdAt: project.createdAt,
        lastOpenedAt: project.lastOpenedAt,
      });
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = @id").get({ id });
    return row ? toProject(row) : undefined;
  }

  getByRootPath(rootPath: string): Project | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE root_path = @rootPath ORDER BY last_opened_at DESC LIMIT 1")
      .get({ rootPath });
    return row ? toProject(row) : undefined;
  }

  /** Most recently opened first. */
  list(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC, id").all().map(toProject);
  }

  touch(id: string, at: string = nowIso()): boolean {
    const res = this.db.prepare("UPDATE projects SET last_opened_at = @at WHERE id = @id").run({ id, at });
    return Number(res.changes) > 0;
  }

  /** Cascades to profiles, documents, runs, sessions and artifact rows (files: see ArtifactStore.removeProject). */
  remove(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM projects WHERE id = @id").run({ id }).changes) > 0;
  }
}

function toProject(row: SqlRow): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    createdAt: String(row.created_at),
    lastOpenedAt: String(row.last_opened_at),
  };
}

export interface StoredProfile {
  projectId: string;
  version: number;
  createdAt: string;
  profile: ProjectProfile;
}

/** Append-only, versioned Project Profiles. Saving an unchanged profile does not create a new version. */
export class ProfileRepository {
  constructor(private readonly db: SqlDriver) {}

  save(profile: ProjectProfile, createdAt: string = nowIso()): StoredProfile {
    return this.db.transaction(() => {
      const hash = hashJson(profile);
      const latest = this.latestRow(profile.projectId);
      if (latest && latest.profile_hash === hash) return toStored(latest);
      const version = latest ? num(latest.version) + 1 : 1;
      this.db
        .prepare(
          `INSERT INTO project_profiles (project_id, version, schema_version, profile_json, profile_hash, created_at)
           VALUES (@projectId, @version, @schemaVersion, @json, @hash, @createdAt)`,
        )
        .run({
          projectId: profile.projectId,
          version,
          schemaVersion: profile.schemaVersion,
          json: JSON.stringify(profile),
          hash,
          createdAt,
        });
      return { projectId: profile.projectId, version, createdAt, profile: structuredClone(profile) };
    });
  }

  getLatest(projectId: string): ProjectProfile | undefined {
    return this.getLatestStored(projectId)?.profile;
  }

  getLatestStored(projectId: string): StoredProfile | undefined {
    const row = this.latestRow(projectId);
    return row ? toStored(row) : undefined;
  }

  get(projectId: string, version: number): StoredProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM project_profiles WHERE project_id = @projectId AND version = @version")
      .get({ projectId, version });
    return row ? toStored(row) : undefined;
  }

  listVersions(projectId: string): Array<{ version: number; createdAt: string }> {
    return this.db
      .prepare("SELECT version, created_at FROM project_profiles WHERE project_id = @projectId ORDER BY version")
      .all({ projectId })
      .map((r) => ({ version: num(r.version), createdAt: String(r.created_at) }));
  }

  private latestRow(projectId: string): SqlRow | undefined {
    return this.db
      .prepare("SELECT * FROM project_profiles WHERE project_id = @projectId ORDER BY version DESC LIMIT 1")
      .get({ projectId });
  }
}

function toStored(row: SqlRow): StoredProfile {
  return {
    projectId: String(row.project_id),
    version: num(row.version),
    createdAt: str(row.created_at) ?? "",
    profile: JSON.parse(String(row.profile_json)) as ProjectProfile,
  };
}
