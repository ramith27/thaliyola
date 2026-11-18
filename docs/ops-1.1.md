# Ops notes for Thaliyola 1.1.0

Three things for the ops team. None of them is a code change in this repository; the exact steps are in [`deploy/k8s/README.md`](../deploy/k8s/README.md#ops-checklist-for-thaliyola-main-110).

1. **`BUILD_SHA` in CI.** The image needs `--build-arg BUILD_SHA=$CI_COMMIT_SHA`, or `/healthz` reports `"commit": null`. `.gitlab-ci.yml` only includes the shared `cap_tech1/ci-scripts` template, so this repository can't add it. If the template's Kaniko job appends `$KANIKO_BUILD_ARGS`, set that as a project CI/CD variable (`--build-arg BUILD_SHA=$CI_COMMIT_SHA`); if it doesn't, the CI owners add it to the template first.
2. **Two replicas of `thaliyola-main`.** Move uploaded files to S3 (`ASSET_STORE=s3` and the `S3_*` settings, then copy the pod's `/data/assets` into the bucket) before raising `replicas` to 2. The manifest diff (rolling update, probes, `preStop`, grace period, PodDisruptionBudget, `TRUST_PROXY=1`) is in the checklist.
3. **The claude-skills source.** After 1.1.0 is live: add the git source (`git.cap-cloud.co` in `SKILLS_GIT_HOSTS`), make its webhook secret, and add the webhook in GitLab.

After deploying, check `curl -s https://<thaliyola-host>/healthz`: `"version": "1.1.0"` and the deployed commit.
