#!/usr/bin/env python3
"""Report a failed upstream sync as a Linear issue, or add the failure to the issue already open.

Both forks (herdr-app, herdr-core) carry the same copy of this script. It needs
LINEAR_API_KEY (a personal key that can read, create issues and comment in team
LPT) and GH_TOKEN (to read the failed jobs' logs of this run).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request

LINEAR_API = "https://api.linear.app/graphql"
TEAM = "LPT"
PROJECT = "herdr-config"
LOG_LINES = 30

FIND = """query($team: String!, $project: String!, $title: String!) {
  teams(filter: {key: {eq: $team}}) { nodes { id } }
  projects(filter: {name: {eq: $project}}) { nodes { id } }
  issues(first: 1, filter: {team: {key: {eq: $team}}, title: {eq: $title}, state: {type: {nin: ["completed", "canceled"]}}}) {
    nodes { id identifier url }
  }
}"""
CREATE = """mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }"""
COMMENT = """mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }"""


def linear(key):
    def post(query, variables):
        body = json.dumps({"query": query, "variables": variables}).encode()
        request = urllib.request.Request(LINEAR_API, body, {"Authorization": key, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        if result.get("errors"):
            raise RuntimeError("Linear: " + "; ".join(e.get("message", "?") for e in result["errors"]))
        return result["data"]
    return post


def error_context(log, lines=LOG_LINES):
    """The lines that lead up to the first error of a job log, without timestamps."""
    text = [re.sub(r"^\S+Z ", "", line) for line in log.splitlines()]
    end = next((i for i, line in enumerate(text) if "##[error]" in line), len(text) - 1)
    return "\n".join(text[max(0, end - lines + 1):end + 1])


def failed_job_logs(repo, run_id):
    """(heading, text) for each failed job of this run: the end of its log, or why GitHub could not give it."""
    def gh(*args):
        return subprocess.run(["gh", "api", *args], text=True, capture_output=True, check=True).stdout
    try:
        listed = json.loads(gh(f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"))["jobs"]
        jobs = [job for job in listed if job.get("conclusion") == "failure"]
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        return [("Could not list the failed jobs of this run:", str(error))]
    logs = []
    for job in jobs:
        try:
            logs.append((f"End of the failed `{job['name']}` log:", error_context(gh(f"repos/{repo}/actions/jobs/{job['id']}/logs"))))
        except subprocess.CalledProcessError as error:
            logs.append((f"Could not read the `{job['name']}` log:", str(error)))
    return logs


def describe(repo, run_url, results, logs):
    parts = [
        f"The nightly upstream sync of `{repo}` failed; master is unchanged.",
        "",
        f"Run: {run_url}",
        "Jobs: " + ", ".join(f"{name} {result}" for name, result in results),
    ]
    for heading, text in logs:
        parts += ["", heading, "```", text, "```"]
    parts += [
        "",
        "To fix it, find the cause in the run. A conflict the automation could not resolve, or a failed check on the "
        "merge, needs a hand merge: merge upstream/master into a branch, fix it and land it through a PR with a merge "
        "commit. docs/FORK.md in the repository describes the sync.",
    ]
    return "\n".join(parts)


def report(post, repo, run_url, results, logs):
    """Comment on the open issue for this repository's sync, or open one. Returns what it did."""
    title = f"Upstream sync of {repo} is failing"
    found = post(FIND, {"team": TEAM, "project": PROJECT, "title": title})
    description = describe(repo, run_url, results, logs)
    issues = found["issues"]["nodes"]
    if issues:
        post(COMMENT, {"input": {"issueId": issues[0]["id"], "body": "Failed again.\n\n" + description}})
        return {"action": "commented", "issue": issues[0]["identifier"], "url": issues[0]["url"]}
    if not found["teams"]["nodes"]:
        raise RuntimeError(f"Linear team {TEAM} not found")
    issue = {"teamId": found["teams"]["nodes"][0]["id"], "title": title, "description": description, "priority": 2}
    if found["projects"]["nodes"]:
        issue["projectId"] = found["projects"]["nodes"][0]["id"]
    created = post(CREATE, {"input": issue})["issueCreate"]
    if not created["success"]:
        raise RuntimeError("Linear did not create the issue")
    return {"action": "created", "issue": created["issue"]["identifier"], "url": created["issue"]["url"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name of the fork")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--result", action="append", default=[], metavar="JOB=RESULT", help="a job of the sync and its result")
    args = parser.parse_args()
    key = os.environ.get("LINEAR_API_KEY")
    if not key:
        raise RuntimeError("LINEAR_API_KEY is not set")
    results = [tuple(item.split("=", 1)) for item in args.result]
    print(json.dumps(report(linear(key), args.repo, args.run_url, results, failed_job_logs(args.repo, args.run_id))))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
