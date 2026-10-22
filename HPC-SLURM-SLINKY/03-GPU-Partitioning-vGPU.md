---
title: Dividing a GPU - MIG, vGPU, Time-Slicing, MPS
tags: [gpu, mig, vgpu, sriov, slurm, kubernetes, slinky, beginner]
---

# How do I divide a GPU into smaller pieces?

"vGPU" gets used loosely for several different technologies. They all answer
the same question - "can more than one job/user share one physical GPU?" -
but trade off isolation vs. flexibility differently. Pick the row that
matches what you actually need.

| Technology | What it is | Isolation | Typical use |
|---|---|---|---|
| **MIG** (Multi-Instance GPU) | Splits one physical GPU into several real hardware-isolated mini-GPUs (own memory, own compute cores) | Strong (hardware) | Bare-metal, containers, Slurm, Kubernetes - most common choice today |
| **NVIDIA vGPU** (GRID) | A licensed hypervisor product that presents one physical GPU as several virtual GPUs to separate VMs | Strong (driver-managed) | VMware/KVM virtual machines, VDI, cloud GPU rental |
| **Time-slicing** | All processes share the whole GPU, taking turns very fast (no real split) | None (shared memory/faults) | Dev/test, bursty low-priority workloads, cheap "more pods per GPU" |
| **MPS** (Multi-Process Service) | Multiple processes submit work concurrently to one GPU through a shared daemon, instead of in turns | Partial (no memory isolation) | Many small MPI ranks/processes that each underuse a whole GPU |
| **Full GPU passthrough** | One job/VM gets the entire physical GPU | N/A (not shared) | Big training jobs, no sharing needed |

Only **MIG** and **NVIDIA vGPU** truly "divide" the GPU into isolated
pieces. Time-slicing and MPS just let multiple things take turns on the
same, undivided GPU. The rest of this note focuses on MIG since it's what
you use on Slurm/Kubernetes/Slinky clusters (vGPU is a VMware/KVM
virtualization product, licensed separately through NVIDIA, and mostly
unrelated to Slurm/container clusters).

## Option A: NVIDIA MIG (the common answer for Slurm/Kubernetes clusters)

Requires a MIG-capable GPU (A100, A30, H100, H200, B200, some RTX PRO
Blackwell cards) and a recent NVIDIA driver. MIG mode is off by default.

### 1. Turn on MIG mode (once per GPU, as root)
```bash
nvidia-smi -i 0 -mig 1          # enable MIG on GPU 0 (may trigger a GPU reset)
nvidia-smi -i 0 --query-gpu=mig.mode.current --format=csv   # confirm: Enabled
```

### 2. See what sizes ("profiles") you can carve it into
```bash
nvidia-smi mig -lgip
```
Example output on an A100 40GB: you can mix and match profiles such as
`1g.5gb` (up to 7 of them), `2g.10gb` (up to 3), `3g.20gb` (up to 2), or
`7g.40gb` (the whole card as 1). The name `Ng.Mgb` means "N compute slices,
M GB of memory."

### 3. Create the GPU instances (the actual "slicing")
```bash
# split GPU 0 into two equal halves, each 3g.20gb
sudo nvidia-smi mig -cgi 9,9 -C
```
`-cgi` = create GPU instances (by profile ID or name), `-C` = also create
the matching "Compute Instance" inside each one (required before CUDA code
can actually run on it).

```bash
nvidia-smi mig -lgi        # list the GPU instances you just made
nvidia-smi                 # now shows separate "MIG devices", each like a mini-GPU
```
From here, each MIG slice shows up as its own CUDA device (e.g.
`/dev/nvidia-caps/...`), usable independently by separate jobs/containers.

MIG instances are **not persistent across reboot** - use
[mig-parted](https://github.com/nvidia/mig-parted) (NVIDIA's tool) plus a
systemd service if you want the same layout recreated automatically on
startup.

## Using MIG with Slurm

Slurm can auto-detect MIG slices as GPU resources (GRES = Generic Resource):

`/etc/slurm/gres.conf` on the GPU node:
```
AutoDetect=nvml
```
`/etc/slurm/slurm.conf`, declare the node as if the MIG slices were normal
GPUs:
```
NodeName=gpu01 Gres=gpu:3g.20gb:2 ...
```
Then users request a slice just like a normal GPU:
```bash
#SBATCH --gres=gpu:3g.20gb:1
```
Slurm schedules jobs onto whichever MIG slice is free, same workflow as any
other GRES - see `01-SLURM-Basics.md` for the general job script pattern.

## Using MIG with Kubernetes / Slinky

The [NVIDIA GPU Operator](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/index.html)
handles this for you on Kubernetes (and therefore for Slinky's `slurmd`
worker pods too, since they run as normal Kubernetes pods on GPU nodes):

- Set a **MIG strategy** when installing the GPU Operator:
  - `single` - every MIG device on the node looks like one uniform GPU type
    (simplest; all slices must be the same size).
  - `mixed` - different slice sizes on the same node are exposed as
    distinct resource types (e.g. `nvidia.com/mig-3g.20gb`).
- A pod then just requests the resource it needs:
  ```yaml
  resources:
    limits:
      nvidia.com/mig-3g.20gb: 1
  ```
- If you don't need hardware isolation and just want "more pods per GPU"
  cheaply, the GPU Operator also supports **time-slicing** instead of MIG,
  configured via a ConfigMap (`replicas: N` per GPU) - easier to set up, but
  no memory/fault isolation between the pods sharing it.

In Slinky terms: this is a worker-node (NodeSet) concern. You install the
GPU Operator + configure MIG/time-slicing on the Kubernetes nodes backing
your NodeSet, same as you would for any GPU Kubernetes workload; Slinky's
`slurmd` pods then expose those GPUs/MIG-slices to Slurm jobs as GRES, same
as the bare-metal Slurm setup above.

## Option B: NVIDIA vGPU (only relevant for VM-based virtualization)

NVIDIA vGPU (branded "GRID") is a different, *licensed* product for
hypervisors (VMware vSphere, Citrix, KVM/Proxmox via NVIDIA AI Enterprise).
It splits a physical GPU into virtual GPUs assigned to separate **virtual
machines**, each running its own OS and NVIDIA vGPU guest driver, managed by
a vGPU manager installed on the hypervisor host. You'd reach for this if
your cluster is built on VMs rather than bare-metal/containers (e.g. VDI,
multi-tenant cloud GPU rental) - most HPC/Slurm/Slinky setups use bare-metal
or containers, so MIG is the more common answer there.

## Where does SR-IOV fit in?

SR-IOV (Single Root I/O Virtualization) is a **PCIe standard**, not
GPU-specific. It lets one physical PCIe device (the "Physical Function",
PF) expose several lightweight **Virtual Functions (VFs)** on the bus. Each
VF can be handed directly to a separate VM or container, bypassing the
hypervisor/host kernel for most I/O, so it behaves almost like a real
separate device with near-native performance.

It connects to the previous section like this:

- **MIG partitions the silicon** (compute cores + memory) inside the GPU
  itself. It does not use SR-IOV and does not, by itself, do anything about
  PCIe-level device virtualization.
- **NVIDIA vGPU is built on top of SR-IOV.** On SR-IOV-capable GPUs (Ampere
  and newer), enabling vGPU mode creates PCIe VFs on the physical GPU; each
  VF is what gets passed through to a guest VM as its own vGPU device,
  managed by NVIDIA's Virtual GPU Manager on the host. So "vGPU" =
  NVIDIA's software/licensing layer, **implemented using** SR-IOV as the
  underlying PCIe mechanism.
- **The two combine**: a MIG instance can itself be exposed to a VM as a
  SR-IOV virtual function ("MIG-backed vGPU"). That gives you both hardware
  partitioning (MIG) *and* clean VM-level passthrough (SR-IOV/vGPU) at the
  same time - e.g. 7 MIG slices on one A100, each handed to a different VM
  as its own VF.
- **Plain MIG on bare metal/containers (Slurm, Kubernetes, Slinky) does not
  need SR-IOV at all** - containers/pods already share the host kernel, so
  MIG slices are just exposed as device nodes, no PCIe VF needed. You only
  need SR-IOV when a full VM boundary is involved.

### The other common HPC use of SR-IOV: networking, not GPUs

In Slurm/Kubernetes/Slinky clusters, SR-IOV shows up just as often (maybe
more often) on the **network card**, not the GPU: InfiniBand/RoCE NICs
expose VFs so that VMs or Kubernetes pods get a direct, hardware-level path
to the fabric for RDMA - critical for multi-node MPI jobs where network
latency matters. On Kubernetes/Slinky this is handled by the [SR-IOV Network
Device Plugin](https://github.com/k8snetworkplumbingwg/sriov-network-device-plugin)
or NVIDIA's Network Operator, which advertise NIC VFs as a schedulable
resource, the same pattern as the GPU device plugin:
```yaml
resources:
  limits:
    nvidia.com/mig-3g.20gb: 1
    nvidia.com/sriov_rdma: 1
```
So: SR-IOV for GPUs enables VM-level vGPU passthrough; SR-IOV for NICs
enables fast, isolated networking for MPI pods/jobs. Same underlying PCIe
trick, two different devices.

## Quick decision guide

- Need strict isolation (security, "noisy neighbor" protection, predictable
  performance) and have an A100/H100-class GPU -> **MIG**.
- Running on VMware/KVM and need to split a GPU across VMs -> **NVIDIA vGPU**.
- Just want to cram more small dev/test pods onto one GPU and don't care
  about isolation -> **time-slicing**.
- Many lightweight processes (e.g. MPI ranks) that each only need a little
  GPU compute, sharing is fine -> **MPS**.
- One job genuinely needs the whole GPU -> don't partition it at all.
