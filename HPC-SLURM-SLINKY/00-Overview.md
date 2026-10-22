---
title: Overview - HPC, SLURM, and Slinky
tags: [hpc, slurm, slinky, overview, beginner]
---

# Overview

A beginner-friendly map of three related topics: **HPC** (the field), **Slurm**
(a tool used in that field), and **Slinky** (a newer project that runs Slurm
inside Kubernetes). Read this file first, then the others for detail.

## What is HPC?

HPC = High Performance Computing. Instead of running a program on one laptop,
you run it across many connected computers ("nodes") at the same time, so it
finishes in hours instead of weeks. An HPC cluster typically looks like this:

- **Login node(s)**: where users connect (via SSH) to write/submit jobs. You
  never run heavy computation directly here.
- **Compute nodes**: the actual worker machines that run the jobs (CPUs,
  sometimes GPUs).
- **Scheduler / workload manager**: decides which job runs on which node and
  when (this is where Slurm comes in).
- **Shared storage**: a file system (e.g. NFS, Lustre) visible from every
  node, so a job can read/write files regardless of which node it lands on.

Typical HPC users: scientists running simulations (weather, physics,
genomics), engineers doing large data processing, and increasingly, AI/ML
teams training or serving large models across many GPUs.

## What is Slurm?

Slurm (Simple Linux Utility for Resource Management) is the most widely used
open-source **workload manager / job scheduler** for HPC clusters. It answers
three questions:

1. Who gets which compute resources, and for how long? (allocation)
2. How do we actually start/monitor/stop the work on those resources? (execution)
3. What happens when there's more work requested than resources available? (queueing)

You write a small script describing "I need N nodes/CPUs/GPUs for X minutes,
run this program," hand it to Slurm with one command, and Slurm queues it,
runs it when resources free up, and records the result. See `01-SLURM-Basics.md`.

## What is Slinky?

Slinky is a project by SchedMD (the company that makes Slurm) that lets you
run a full Slurm cluster **on top of Kubernetes**, instead of on
traditionally-managed bare-metal/VM nodes. It packages Slurm's daemons
(controller, compute nodes, login nodes, etc.) as Kubernetes pods managed by
a Kubernetes Operator, so Kubernetes handles the "keep these pods alive,
scale them, schedule them onto hardware" part, while Slurm still does the HPC
job scheduling. See `02-Slinky.md`.

## How the three fit together

```
HPC                 <- the field / goal (run big computations fast, across many machines)
 |
 +-- Slurm           <- the scheduler that makes HPC clusters usable (classic, bare-metal/VM)
       |
       +-- Slinky    <- runs that same Slurm scheduler inside Kubernetes pods
```

Analogy: HPC is "the job of organizing a big factory." Slurm is "the foreman
who decides which machine does which task and for how long." Slinky is
"running that same foreman and factory floor inside shipping containers
(Kubernetes pods) instead of a fixed building," so it's easier to move,
resize, and share with other cloud-native workloads.

## Why would anyone want Slinky instead of plain Slurm?

- Organizations already standardized their infrastructure on Kubernetes and
  don't want to maintain a second, separate way of managing bare-metal/VM
  clusters just for Slurm.
- They want to share the *same* physical nodes between classic Slurm batch
  jobs (e.g. long AI training runs) and Kubernetes-native services (e.g. a
  chatbot API that needs to scale up/down quickly), instead of running two
  separate siloed clusters.
- Kubernetes brings autoscaling, self-healing pods, and standard container
  images; Slurm brings deterministic scheduling, accounting, fairshare,
  reservations, and job queues that HPC/AI teams already know how to use.

## Glossary (quick reference)

| Term | Meaning |
|---|---|
| Node | A single computer/machine in the cluster |
| Job | A unit of work submitted to the scheduler |
| Partition | A named group of nodes with rules (like a "queue") in Slurm |
| Job step | A piece of work inside a job (a job can have several) |
| Job array | Many near-identical jobs submitted as one group (e.g. process 1000 files) |
| slurmctld | Slurm's central controller daemon (the "brain") |
| slurmd | Slurm's daemon that runs on each compute node (does the actual work) |
| Kubernetes pod | The smallest deployable unit in Kubernetes, one or more containers |
| Kubernetes Operator | Custom software that manages the lifecycle of an app (here: Slurm) on Kubernetes |
| CRD | Custom Resource Definition - how Kubernetes learns about new object types, e.g. "SlurmCluster" |

## Where to go next

- `01-SLURM-Basics.md` - commands, job scripts, running your first jobs
- `02-Slinky.md` - architecture, components, quick start
- `03-GPU-Partitioning-vGPU.md` - splitting one GPU into many (MIG, vGPU, time-slicing, MPS)
