import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// GitHub's published SSH host key; the worker never trusts a key on first use.
const GITHUB_HOST_KEY =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

export type Repository = {
  /** SSH push URL, e.g. git@github.com:owner/repo.git */
  url: string;
  branch: string;
};

/** Netlify reports the linked repository as an HTTPS URL; publication pushes over SSH. */
export function repositoryFor(repoUrl: string | undefined, branch?: string) {
  const match = repoUrl?.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (!match)
    throw new Error(
      "Link this Netlify site to its GitHub repository before publishing.",
    );
  return {
    url: `git@github.com:${match[1]}/${match[2]}.git`,
    branch: branch || "main",
  } satisfies Repository;
}

/** A publisher clone that never reads Carlos's Git configuration or signing agent. */
export function publisherGit(options: { clone: string; key: string }) {
  const knownHosts = join(dirname(options.clone), "known_hosts");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dirname(options.clone),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: `ssh -F /dev/null -i ${options.key} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}`,
  };
  const settings = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Portal publisher",
    "-c",
    "user.email=246254+disusered@users.noreply.github.com",
    "-c",
    "gpg.format=ssh",
    "-c",
    `user.signingkey=${options.key}`,
    "-c",
    "gpg.ssh.program=ssh-keygen",
  ];
  async function git(args: string[], cwd = options.clone) {
    const { stdout } = await exec("git", [...settings, ...args], {
      cwd,
      env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  }
  return {
    /** Clone once, then always start from the remote branch so a template push is never lost. */
    async sync(repository: Repository) {
      await mkdir(dirname(options.clone), { recursive: true, mode: 0o700 });
      await writeFile(knownHosts, `${GITHUB_HOST_KEY}\n`, { mode: 0o600 });
      try {
        await lstat(join(options.clone, ".git"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await git(
          [
            "clone",
            "--quiet",
            "--single-branch",
            "--branch",
            repository.branch,
            repository.url,
            options.clone,
          ],
          dirname(options.clone),
        );
      }
      if ((await git(["remote", "get-url", "origin"])) !== repository.url)
        throw new Error("The publisher clone points at another repository.");
      await git(["fetch", "--quiet", "origin", repository.branch]);
      await git(["reset", "--quiet", "--hard", `origin/${repository.branch}`]);
      await git(["clean", "--quiet", "-fd"]);
      return git(["rev-parse", "HEAD"]);
    },
    /** Write public files, refusing hand-written posts and symlinked paths. */
    async write(files: Map<string, Buffer>) {
      const root = resolve(options.clone);
      for (const [path, bytes] of files) {
        if (path.startsWith("/") || path.split("/").includes(".."))
          throw new Error("Publication paths must stay inside the repository.");
        let current = root;
        for (const part of path.split("/")) {
          current = join(current, part);
          try {
            if ((await lstat(current)).isSymbolicLink())
              throw new Error("Publication paths cannot contain symlinks.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const target = join(root, path);
        if (path.startsWith("src/content/blog/")) {
          for (const sibling of [target, target.replace(/\.md$/, ".mdx")]) {
            const existing = await readFile(sibling, "utf8").catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              },
            );
            if (existing !== undefined && !/^publicationHash:/m.test(existing))
              throw new Error(
                `The permalink collides with existing writing: ${path}`,
              );
          }
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
    },
    /** Commit the written paths with the publisher's signature; unchanged files make no commit. */
    async commit(paths: string[], message: string) {
      await git(["add", "--", ...paths]);
      try {
        await git(["diff", "--cached", "--quiet"]);
        return undefined;
      } catch {
        await git(["commit", "--quiet", "-S", "-m", message]);
        return git(["rev-parse", "HEAD"]);
      }
    },
    /** Push; a rejected push means the branch moved and the caller starts again. */
    async push(repository: Repository) {
      try {
        await git(["push", "--quiet", "origin", `HEAD:${repository.branch}`]);
        return true;
      } catch (error) {
        if (/rejected|non-fast-forward|fetch first/i.test(String(error)))
          return false;
        throw new Error("The publisher could not push to the repository.", {
          cause: error,
        });
      }
    },
    /** True when the remote branch already contains the commit. */
    async published(commit: string, repository: Repository) {
      await git(["fetch", "--quiet", "origin", repository.branch]);
      try {
        await git([
          "merge-base",
          "--is-ancestor",
          commit,
          `origin/${repository.branch}`,
        ]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
