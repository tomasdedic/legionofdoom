---
title: Slinky - Slurm on Kubernetes
tags: [slinky, slurm, kubernetes, hpc, beginner]
---

# Slinky

Slinky is SchedMD's (the makers of Slurm) open-source project to run Slurm
**inside Kubernetes**, instead of on classic bare-metal/VM nodes managed by
hand. It is co-developed/supported with NVIDIA. Project: https://slinky.schedmd.com/

## Why does this exist?

Kubernetes and Slurm were built for different jobs:

| | Kubernetes | Slurm |
|---|---|---|
| Good at | long-running services, loose resource requirements, auto-scaling, single-node pods | short/finite, well-defined multi-node jobs, strict policy/queueing |
| Resource pool | treated as effectively infinite / elastic | known, fixed set of nodes |

Many organizations now want **both**: cloud-native services (APIs, chatbots,
inference endpoints) *and* classic HPC/AI-training batch jobs, ideally on the
same shared pool of machines instead of two separate siloed clusters (which
wastes capacity and doubles operational work). Slinky lets both coexist on
Kubernetes.

## The two main pieces

1. **slurm-operator** - a Kubernetes Operator (custom controllers + CRDs)
   that deploys and manages a full Slurm cluster's components as pods:
   controller (`slurmctld`), accounting (`slurmdbd`), REST API
   (`slurmrestd`), compute/worker nodes (`slurmd`, called "NodeSets"), and
   login nodes ("LoginSets"). This is the main thing people mean by "Slinky."
2. **slurm-bridge** - a Kubernetes scheduler plugin that lets select
   Kubernetes workloads be scheduled by/alongside Slurm, so Kubernetes pods
   and Slurm jobs can share the exact same nodes.

## Key concepts (Slinky-specific)

- **NodeSet**: a group of homogeneous Slurm compute-node pods (`slurmd`).
  Can scale like a normal replica set (fixed count, scales with demand,
  including scale-to-zero) or one-pod-per-Kubernetes-node (like a
  DaemonSet), depending on your needs.
- **LoginSet**: a group of login-node pods where users SSH in and submit
  jobs with the usual `sbatch`/`srun`/`squeue` commands - from a user's
  point of view, it feels just like a normal Slurm cluster.
- **High availability for free**: if the controller pod crashes, Kubernetes
  just restarts it - no need for Slurm's own backup-controller HA setup.
- **Config changes without downtime**: edit a ConfigMap, the operator
  detects it and reconfigures the running cluster.
- **Autoscaling**: NodeSets can scale down to zero and back up based on
  Slurm's own job queue (e.g. via KEDA / HPA), so idle compute costs nothing.

## Architecture (who runs where)

- Controller pod (`slurmctld`) and accounting pod (`slurmdbd`, backed by a
  MariaDB database) usually run on general-purpose Kubernetes nodes.
- Worker pods (`slurmd`) run on your accelerated/compute nodes (e.g. GPU
  instances), selected via standard Kubernetes `nodeSelector` rules.
- Login pods run `sshd` + `sackd` (authentication) so users can SSH in and
  submit jobs exactly like on a traditional cluster.
- A metrics exporter turns Slurm's job/node/partition info into Prometheus
  metrics, so you can feed dashboards (Grafana) or autoscalers (KEDA).

## Quick start (illustrative - needs a real Kubernetes cluster + Helm)

```bash
# 1. cert-manager is a prerequisite (used for internal TLS certs)
helm install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true

# 2. Install the Slinky operator and its CRDs
helm install slurm-operator-crds oci://ghcr.io/slinkyproject/charts/slurm-operator-crds
helm install slurm-operator oci://ghcr.io/slinkyproject/charts/slurm-operator \
  --namespace=slinky --create-namespace

# 3. Install an actual Slurm cluster (one NodeSet named "slinky", one partition "all")
helm install slurm oci://ghcr.io/slinkyproject/charts/slurm \
  --set-json 'nodesets={"slinky":{}}' \
  --set "partitions.all.enabled=true" \
  --namespace=slurm --create-namespace
```
After this, you `kubectl exec` (or SSH) into a login pod and use normal Slurm
commands (`sinfo`, `sbatch`, `squeue`...) exactly as described in
`01-SLURM-Basics.md` - Slinky's whole point is that the *user experience of
Slurm doesn't change*, only *how/where it's deployed* changes.

## Real-world use case example: Slurm on Amazon EKS

AWS published a reference architecture ("Slurm on EKS blueprint") showing:

- `slurmctld`/`slurmdbd`/`slurmrestd` on regular EKS nodes.
- `slurmd` worker pods on GPU EC2 instances, with a high-performance shared
  file system (Amazon FSx for Lustre) mounted for job data.
- A load balancer routing SSH traffic to login pods.
- KEDA/Karpenter scaling GPU worker pods up when the Slurm job queue grows,
  and down to zero when idle, to save GPU cost.

Typical scenario this solves: a research org runs long multi-hour Slurm
batch jobs (genome sequencing, climate simulation, AI model training)
*and* wants to host fast-scaling Kubernetes-native services (a chat/
inference API) on the very same cluster, instead of maintaining two
separate environments.

## Slinky vs. alternatives (quick orientation)

- **AWS ParallelCluster**: full DIY Slurm cluster automation on EC2, no
  Kubernetes involved.
- **AWS Parallel Computing Service**: fully managed Slurm-as-a-service.
- **SageMaker HyperPod**: managed, self-healing clusters purpose-built for
  large AI training, can also use Slurm scheduling on top.
- **Volcano / Apache YuniKorn / Kueue**: Kubernetes-native batch schedulers
  that solve a similar "batch jobs on Kubernetes" problem *without* using
  Slurm at all - good options if your team doesn't already depend on Slurm.

Slinky is specifically the choice when you want to keep using real Slurm
(and all its scheduling features: fairshare, QoS, reservations, accounting)
but deploy and operate it the Kubernetes way.

## When NOT to bother with Slinky

If you only need classic HPC batch jobs and don't already run/need
Kubernetes, plain Slurm (or AWS ParallelCluster) is simpler - don't add a
Kubernetes layer you don't need just because it's new. Slinky earns its
complexity when you specifically need to share nodes between Slurm batch
workloads and Kubernetes-native services.
