# Research: BXI, LUMAI, MIMER (technical view)

Sources: public web only (Bull, EuroHPC JU, Lumai sites, Glenn Klockwood notes, search snippets of The Next Platform / HPCwire). No client or internal data used.

## 1. BXI (BullSequana eXascale Interconnect)

What: HPC/AI network (NIC + switch + software) from Bull (ex-Eviden, Atos group). Developed with CEA (French atomic energy agency).

Generations:
- v1/v2: hardware implementation of the Portals protocol (per Klockwood). v2 used e.g. in a CEA GH200 system (quad-rail), per ECLAT slides.
- v3 (2024/2025): Ethernet-based, aligned with Ultra Ethernet Consortium (UEC). Bull is the only European UEC founding member.

BXI v3 technical points:
- Switch: 64 ports x 800G, breakout to 128 x 400G. See section 1b. (Earlier draft said v3 switch is TSMC N12 in-house: wrong, N12 was the earlier homegrown ASIC.)
- NIC: SmartNIC, 400G per port. Klockwood says FPGA-based; Next Platform says designed by Eviden with an ASIC team. Sources conflict.
- Offload of protocol work from CPU/GPU to the NIC. Plug-and-play for OpenMPI (HPC) and NCCL/RCCL (AI).
- Guaranteed packet delivery and ordering, congestion management, low latency, Ethernet interoperability.
- Funding: NET4EXA project, EUR 71M, EuroHPC JU, managed by CEA, through 2027 (Klockwood).
- Bull claim: GPUs sit idle up to 70% of time with CPU-bound networking. This is a vendor claim, not measured by a third party.

Gaps: datasheet PDF is behind a form (not read). No independent benchmarks found. FPGA NIC (not ASIC) is a likely limit on cost and power; verify.

## 1b. BXI v3 technical detail

Sources: Eviden slides "BXI v3 features for applications" (G. Pichon, ECLAT, 11/2024, public PDF at eclat-lab.fr); The Next Platform, 2024-12-10 (interview with Eric Eppe, Eviden). Vendor figures, no independent tests found.

Architecture
- Two traffic flows on one fabric: standard IP/Ethernet, and Portals-over-Ethernet for HPC/AI. BXI is a commercial Portals 4 implementation (Portals from Sandia Labs).
- Switch: full crossbar, 64 x 800G (or 128 x 400G), ~200 ns port-to-port, air or liquid cooled. Eviden says it is a custom version of a merchant Ethernet switch ASIC (vendor not named: one of Broadcom, Cisco, Marvell, Nvidia). Customizations are Eviden-only.
- NIC: 400G, 220 Mmsg/s, ~1 us latency, PCIe Gen5 x16. Mezzanine, PCIe and OCP-3 forms. Two NICs on one board (two 400G ports), occupies two PCIe5 slots (Next Platform).
- Fabric: up to 64K NICs per fabric, up to 128 interconnected fabrics. Fat-tree, Dragonfly+, route-optimized fat-tree. Native Ethernet frame interoperability.
- Routing: adaptive routing and congestion management using NIC/switch telemetry. Full route update across switches under 200 ms, often under 50 ms (Eppe).
- Ordering: packet spraying over multiple paths, NIC reorders so host sees in-order delivery (MPI needs order).

NIC offload
- DMA to host memory over PCIe.
- Hardware message matching at reception (MPI tags, match-bits/ignore-bits, source, size). Up to 32M receive buffers, over 2M contexts (BlueField-3: 250K, per Eppe).
- Address translation via ATS/PRI: no memory pinning or registration needed before transfers.
- Very large command queues (millions of commands), fair autonomous progress.
- Atomic unit and triggered operations: transfers fire on network events (counting events). Used to offload MPI reduce and collectives: MPI builds a rank tree, posts triggered put-atomic operations, NIC runs them while the app computes (needs non-blocking MPI collectives).
- TCP offload: checksum, GSO, GRO.
- Packets up to 9 MB for elephant flows (Next Platform).

AI features
- Direct transfers to/from GPU memory.
- Transport plugins for NCCL and RCCL.
- NIC atomic unit supports fp16 / bfloat16 reduce.
- Software stack: MPI (OpenMPI), OFI, NCCL/RCCL, Lustre.

Security
- Per-application/per-user access control using Portals Usage-ID, checked at message reception.
- Switch port traffic filtering by pkey / virtual network. 3 traffic classes.
- Signed firmware and secure boot on NIC and switch.

Experimental
- User interrupts (Intel UINTR) delivered by NIC straight to user space. Half round-trip latency: polling 1.3 us, user interrupt 3.7 us, classic interrupt 11.3 us (Compas 2024 paper, hal-04693786, not read).

History and roadmap (Eviden, via Next Platform)
- v1 2017, v2 2021, v3 2025. Systems: Tera-1000-2, CEA-HF, CEA-HE.
- v4 planned fall 2027: 1.6 Tb/s, PCIe 6, CXL memory sharing, more AI offload. v5 about 2029: 3.2 Tb/s switch, PCIe 7. Roadmap, not commitment.
- UEC: Eviden is founding member; claims many UEC-to-be features in v3. UEC spec not ratified at article date.
- Funding: NET4EXA, EuroHPC grant 101175702.

Tools
- S4BXI (github.com/S4BXI/S4BXI): open-source simulator of Portals 4 tuned to model BXI hardware, built on SimGrid.

Not found: public driver/kernel source, OFI provider code, container/Kubernetes integration, independent benchmarks.

## 2. LUMAI

What I found: Lumai is an Oxford University spin-out building optical compute for AI inference (lumai.ai). CEO Xianxin Guo, CTO James Spall.

Technical points (vendor claims):
- Optical matrix multiplier: light beams in 3D free space do the matrix-vector math. Matrix up to 2048 x 2048, INT4/INT8-equivalent precision.
- Hybrid system: optics does the compute-bound part, digital chips do everything else (memory, control). Three-tier memory for KV cache.
- Product: Lumai Iris server. Iris Nova runs Llama 8B and 70B in real time, ready for datacenter evaluation. Iris Aura / Tetra are next generation.
- Target: prefill phase of LLM inference (compute-bound), paired with decode-optimized accelerators (memory-bound).
- Claims: up to 100 TOPS/W, roadmap 50x performance, 90% less power, 10% TCO. No independent benchmark found.

Open point: "LUMAI PROJECT" is not clear. I found no public link between Lumai, Bull, BXI or Mimer. It may be an internal or client project name. Need the project description from you.

## 3. MIMER (Mimer AI Factory, Sweden)

What: EuroHPC AI Factory in Sweden. Hosted and operated by NAISS (National Academic Infrastructure for Supercomputing in Sweden) at Linkoping University, with RISE.

Facts (EuroHPC JU press release, 2026-04-21):
- Vendor: Bull, selected after tender EUROHPC/LUX/2025/CD/0002 (published 23 May 2025).
- Budget EUR 29.76M for acquisition, delivery, installation and maintenance. 50% EuroHPC (Digital Europe Programme), 50% Swedish Research Council.
- Installation starts in 2026. Site says system online in 2027. Until then, projects use existing EuroHPC systems.
- Tender goals: performance/TCO, usability for AI development and deployment, versatility, security (secure processing environments for sensitive data), reliability for industry, energy efficiency.
- Described as cloud-enabled supercomputing plus large-scale storage for sensitive data.
- Focus sectors: life sciences, materials science, autonomous systems, gaming. Users: startups, SMEs, researchers.

Gaps: exact hardware (CPU/GPU type, node count, network) is not public in what I found. Whether it uses BXI is not confirmed. Do not assume it.

## Links between the three
- BXI and Mimer: same vendor (Bull). BXI is Bull's network product. Use in Mimer: unconfirmed.
- Lumai: no public link found.

## Next steps
1. Get the BXI v3 datasheet (form on bull.com).
2. Ask Bull / NAISS for the Mimer technical architecture.
3. Define what "LUMAI PROJECT" means.

## Addendum: Kubernetes / OpenShift

Result: no public source found that links BXI, Lumai or Mimer to Kubernetes or OpenShift.

Checked: Lumai product/technology pages, EuroHPC Mimer press release and tender page, NAISS Mimer page, Bull BXI page. Zero mentions. Not read: EU tender documents (portal needs a browser session), BXI datasheet (form-gated). Web search was unreliable.

Weak hints (inference, not facts):
- Mimer: press release says "cloud-enabled supercomputing", "advanced software layers", "secure processing environments". This often means a container/Kubernetes layer next to Slurm, but the text does not say it.
- BXI v3: Ethernet-based with NCCL/RCCL support. A container platform would need RDMA device plugins to use it. No public statement that this exists.
- Lumai: sells a complete inference server. No software stack details are public.

Other note: Mimer AI Factory was renamed Sweden AI Factory on 2026-08-24 (NAISS). The supercomputer is still called Mimer.

To confirm: ask Bull/NAISS for the Mimer software architecture, or read the tender technical specification.
hello
hello
