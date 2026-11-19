import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("fork-sync.py")


def git(where, *args):
    return subprocess.check_output(["git", "-C", str(where), *args], text=True, stderr=subprocess.DEVNULL).strip()


class ForkSync(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herdr-fork-sync-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.upstream.mkdir()
        git(self.upstream, "init", "-b", "master")
        self.identity(self.upstream)
        self.commit(self.upstream, "base.txt", "base")
        self.fork = self.root / "fork.git"
        git(self.root, "clone", "--bare", str(self.upstream), str(self.fork))
        self.work = self.root / "work"
        git(self.root, "clone", str(self.fork), str(self.work))
        self.identity(self.work)
        self.commit(self.work, "fork.txt", "browser support")
        git(self.work, "push", "origin", "master")
        self.before = git(self.fork, "rev-parse", "master")

    def identity(self, repo):
        git(repo, "config", "user.email", "test@example.invalid")
        git(repo, "config", "user.name", "Test")

    def commit(self, repo, file, value):
        (repo / file).write_text(value)
        git(repo, "add", file)
        git(repo, "commit", "-m", "fixture")

    def sync(self, *args, ok=True):
        result = subprocess.run(["python3", str(SCRIPT), *args], cwd=self.work, text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)

    def prepare(self, ok=True):
        return self.sync("prepare", "--upstream", str(self.upstream), "--branch", "automation/upstream-test", ok=ok)

    def publish(self, candidate, ok=True):
        return self.sync("publish", "--branch", candidate["branch"], "--sha", candidate["sha"], ok=ok)

    def remote_candidates(self):
        return git(self.fork, "for-each-ref", "--format=%(refname)", "refs/heads/automation/")

    def test_verified_candidate_keeps_fork_changes_and_lands_by_fast_forward(self):
        self.commit(self.upstream, "upstream.txt", "new upstream")
        candidate = self.prepare()
        self.assertTrue(candidate["changed"])
        self.assertEqual(git(self.work, "show", candidate["sha"] + ":fork.txt"), "browser support")
        self.assertEqual(git(self.fork, "rev-parse", "master"), self.before)
        self.assertEqual(self.remote_candidates(), "", "prepare pushes nothing")
        self.publish(candidate)
        self.assertEqual(git(self.fork, "rev-parse", candidate["branch"]), candidate["sha"])
        landed = self.sync("land", "--branch", candidate["branch"], "--sha", candidate["sha"])
        self.assertTrue(landed["landed"])
        self.assertEqual(git(self.fork, "rev-parse", "master"), candidate["sha"])
        self.assertEqual(git(self.fork, "show", "master:upstream.txt"), "new upstream")

    def test_no_upstream_change_creates_no_candidate(self):
        result = self.prepare()
        self.assertFalse(result["changed"])
        self.assertEqual(git(self.fork, "rev-parse", "master"), self.before)
        self.assertEqual(git(self.fork, "for-each-ref", "--format=%(refname)", "refs/heads/automation/"), "")

    def test_conflict_does_not_change_remote_master(self):
        self.commit(self.work, "base.txt", "fork version")
        git(self.work, "push", "origin", "master")
        before = git(self.fork, "rev-parse", "master")
        self.commit(self.upstream, "base.txt", "upstream version")
        self.prepare(ok=False)
        self.assertEqual(git(self.fork, "rev-parse", "master"), before)

    def conflict(self):
        self.commit(self.work, "base.txt", "fork version")
        git(self.work, "push", "origin", "master")
        self.commit(self.upstream, "base.txt", "upstream version")

    def resolver(self, body):
        script = self.root / "resolver.py"
        script.write_text("from pathlib import Path\n" + body)
        return "python3 " + str(script)

    def test_a_resolved_conflict_becomes_a_candidate(self):
        self.conflict()
        resolver = self.resolver("Path('base.txt').write_text('both versions')\n")
        candidate = self.sync("prepare", "--upstream", str(self.upstream), "--branch", "automation/upstream-test", "--resolver", resolver)
        self.assertTrue(candidate["changed"])
        self.assertEqual(git(self.work, "show", candidate["sha"] + ":base.txt"), "both versions")
        self.assertEqual(git(self.work, "rev-list", "--parents", "-n1", candidate["sha"]).count(" "), 2)

    def test_a_resolver_that_reports_on_stdout_keeps_the_result_parseable(self):
        self.conflict()
        resolver = self.resolver("Path('base.txt').write_text('both versions')\nprint('- base.txt: kept both')\n")
        candidate = self.sync("prepare", "--upstream", str(self.upstream), "--branch", "automation/upstream-test", "--resolver", resolver)
        self.assertTrue(candidate["changed"])

    def test_a_candidate_that_moved_after_preparation_is_not_published(self):
        self.commit(self.upstream, "upstream.txt", "new upstream")
        candidate = self.prepare()
        self.commit(self.work, "extra.txt", "not verified")
        self.publish(candidate, ok=False)
        self.assertEqual(self.remote_candidates(), "")

    def test_a_resolver_that_leaves_markers_is_rejected(self):
        self.conflict()
        before = git(self.fork, "rev-parse", "master")
        resolver = self.resolver("pass\n")
        self.sync("prepare", "--upstream", str(self.upstream), "--branch", "automation/upstream-test", "--resolver", resolver, ok=False)
        self.assertEqual(git(self.fork, "rev-parse", "master"), before)
        self.assertEqual(git(self.fork, "for-each-ref", "--format=%(refname)", "refs/heads/automation/"), "")

    def test_a_concurrent_master_change_is_not_overwritten(self):
        self.commit(self.upstream, "upstream.txt", "new upstream")
        candidate = self.prepare()
        self.publish(candidate)
        git(self.work, "switch", "master")
        self.commit(self.work, "later.txt", "another task")
        git(self.work, "push", "origin", "master")
        before = git(self.fork, "rev-parse", "master")
        self.sync("land", "--branch", candidate["branch"], "--sha", candidate["sha"], ok=False)
        self.assertEqual(git(self.fork, "rev-parse", "master"), before)

    def test_in_github_actions_a_failure_is_an_error_annotation_with_the_cause(self):
        self.conflict()
        resolver = self.resolver("raise SystemExit(3)\n")
        result = subprocess.run(
            ["python3", str(SCRIPT), "prepare", "--upstream", str(self.upstream), "--branch", "automation/upstream-test", "--resolver", resolver],
            cwd=self.work, text=True, capture_output=True, env={**os.environ, "GITHUB_ACTIONS": "true"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "", "stdout carries only the JSON result")
        self.assertIn("::error title=Upstream sync::The conflict resolver failed on merge conflicts in: base.txt", result.stderr)


if __name__ == "__main__":
    unittest.main()
