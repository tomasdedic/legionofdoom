---
title: Slurm Basics
tags: [slurm, hpc, commands, beginner]
---

# Slurm Basics

Slurm (Simple Linux Utility for Resource Management) is an open-source
cluster scheduler. You tell it "run this program, using this many
nodes/CPUs/GPUs, for up to this long," and it queues and runs the job for
you, fairly sharing the cluster among everyone.

## Architecture in one picture

- `slurmctld` - one central daemon (the "controller"/"brain") that tracks
  all nodes and decides what runs where and when.
- `slurmd` - one daemon per compute node, which actually starts/stops/monitors
  the work on that node.
- **Partitions** - named groups of nodes with rules (time limits, who can use
  them). Think of them as queues, e.g. `debug`, `batch`, `gpu`.
- **Jobs** and **job steps** - a job is a reservation of resources; it can
  contain one or more "job steps" (actual commands that run within it).

## The commands you actually need as a beginner

| Command | What it does |
|---|---|
| `sinfo` | Show the cluster's partitions and node states (what's available) |
| `squeue` | Show the job queue (what's running / pending, and why) |
| `sbatch script.sh` | Submit a batch script to run later (most common way to run things) |
| `srun ...` | Run a command interactively/immediately, often inside a job script |
| `salloc` | Grab an interactive allocation (e.g. to get a shell on compute nodes) |
| `scancel <jobid>` | Cancel a job |
| `sacct` | Show accounting info (CPU time used, exit code, etc.) for past jobs |
| `scontrol show job <id>` | Full detail about a specific job |

Almost everything else (`sacctmgr`, `sprio`, `sshare`, `strigger`, ...) is for
more advanced accounting/priority/admin tasks you won't need on day one.

## Example 1: check the cluster

```bash
sinfo
```
```
PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST
debug*       up      30:00      3   idle adev[3-5]
batch        up      16:00:00   4   idle adev[9-12]
```
`debug*` is the default partition (the `*` marks it). `idle` means free and
ready to take work.

## Example 2: run something immediately with srun

```bash
srun -N3 -l /bin/hostname
```
```
0: adev3
1: adev4
2: adev5
```
`-N3` = use 3 nodes, `-l` = label each output line with its task number. This
runs `/bin/hostname` on 3 separate nodes right now and prints each node's name.

## Example 3: submit a batch job script (the normal workflow)

Create `my_job.sh`:
```bash
#!/bin/bash
#SBATCH --job-name=my_first_job
#SBATCH --output=result_%j.out     # %j = job ID, so output doesn't collide
#SBATCH --time=00:10:00            # max runtime: 10 minutes
#SBATCH --ntasks=1                 # 1 task
#SBATCH --cpus-per-task=4          # 4 CPUs for that task
#SBATCH --mem=4G                   # 4 GB RAM

echo "Running on $(hostname)"
python3 my_analysis.py
```

Submit it, then check on it:
```bash
sbatch my_job.sh          # -> "Submitted batch job 473"
squeue -u $USER           # see it in the queue
sacct -j 473              # see result/timing after it finishes
```

Everything after `#SBATCH` is a resource request; the script body is just a
normal shell script that runs once resources are granted. Output goes to
`result_473.out` in this example.

## Example 4: a job array (run the same script 100 times, different input)

Useful when you have many similar independent tasks (e.g. process 100 data
files).

```bash
#!/bin/bash
#SBATCH --job-name=batch_process
#SBATCH --array=1-100              # creates 100 "tasks," IDs 1..100
#SBATCH --output=logs/out_%A_%a.log  # %A = job id, %a = array index
#SBATCH --time=00:05:00

# SLURM_ARRAY_TASK_ID is set automatically per task (1, 2, 3, ... 100)
python3 process_file.py data/file_${SLURM_ARRAY_TASK_ID}.csv
```
```bash
sbatch array_job.sh
```
One `sbatch` call queues 100 lightweight jobs that Slurm schedules
efficiently, instead of you calling `sbatch` 100 times.

## Example 5: a GPU job

```bash
#!/bin/bash
#SBATCH --job-name=train_model
#SBATCH --partition=gpu
#SBATCH --gres=gpu:1               # request 1 GPU
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=04:00:00

python3 train.py --epochs 50
```
`--gres=gpu:1` is how you ask Slurm for a GPU (the exact name/count depends
on how the cluster is configured, e.g. `--gres=gpu:a100:2` for 2 A100s).

## Example 6: a multi-node MPI job

For programs written to run in parallel across multiple nodes (e.g.
simulations using MPI):

```bash
#!/bin/bash
#SBATCH --job-name=mpi_sim
#SBATCH --nodes=4
#SBATCH --ntasks-per-node=16        # 16 MPI ranks per node = 64 total
#SBATCH --time=02:00:00

srun ./my_mpi_program
```
Slurm allocates the 4 nodes and `srun` launches and coordinates the 64 MPI
processes across them (the exact launch mechanism depends on the MPI
implementation, e.g. OpenMPI/MPICH/Intel MPI).

## Typical beginner workflow

1. SSH into the login node.
2. `sinfo` to see what partitions/resources exist.
3. Write a job script with `#SBATCH` resource requests + your actual command.
4. `sbatch script.sh` to submit it.
5. `squeue -u $USER` to watch it, `scancel <id>` if you need to stop it.
6. Check the `.out` file and `sacct -j <id>` once it's done.

## Real-world use cases for plain Slurm

- A university cluster shared by hundreds of researchers, each submitting
  jobs (simulations, data analysis), with Slurm fairly queueing everyone.
- Weather/climate modeling: a multi-hour multi-node MPI simulation submitted
  as a single batch job.
- Genome sequencing pipelines: thousands of independent per-sample jobs
  handled efficiently as a job array.
- AI/ML training: a job requesting N GPUs across multiple nodes for a
  multi-day training run, with checkpointing so it can resume if preempted.
