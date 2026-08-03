# Adding CI/CD

## Context
Okay, so the purpose of this is to set up CI-CD. The way that we utilize this is using the release branch. I've got an example release script here.
docs\reference\release-script-example.js

Once an update is pushed to the release branch, then a workflow should run to build the Docker container. Like this:
docs\reference\service-deploy-workflow.yml

At the end of that workflow, you'll notice that it makes a request to another workflow in the Civitai deployment repo. And that workflow should essentially trigger the rollout in Kubernetes.
docs\reference\k8s-rollout-example.yml

The application is defined in Kubernetes as outlined here:
k8s\09-metric-watcher-app.yml

## Your Task
1. Create the release script based on the example
2. Create the build workflow and put it in the .github/workflows folder - follow the example provided
3. Create the k8s rollout workflow to add to the deployments repo. Follow the example provided. Write it to `.github/ext/workflows/deploy-metric-watcher-service.yml`