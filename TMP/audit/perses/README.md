# Perses Dashboards for OpenShift (Siemens OCP)

## Storage size

| Step | Formula | Result |
|---|---|---|
| Raw data volume (180d) | 11.0 GB/day × 180 days | **1980.0 GB** |
| Compaction headroom | 11.0 GB/day × min(10% × 180d, 31d) = 11.0 × 18d | **198.0 GB** |
| Required `retentionSize` | 1980.0 GB + 198.0 GB | **≈ 2178.0 GB** |
| Required PVC size | 2178.0 GB ÷ 0.8 | **≈ 2722.5 GB ≈ 2536.3 GiB** |
| **PVC target (rounded)** | | **~2560 Gi per replica** |

### Calculation
```promql
# in Metrics OC console

## Query 1 = x
prometheus_tsdb_storage_blocks_bytes{pod="prometheus-k8s-0"}

## Query 2 = y
(time() - prometheus_tsdb_lowest_timestamp_seconds{pod="prometheus-k8s-0"}) / 86400

#Divide first result (bytes) by second (days) ÷ 1e9 → GB/day. (249.7G / 22.8d = 10.95 GB/day)
```

## Deployment

> **Note:** The Cluster Observability Operator (COO) installation — Namespace `openshift-cluster-observability-operator`, OperatorGroup, and Subscription — is managed by the `logging/` directory. The corresponding files in `perses/Operator/` are renamed to `*.disabled` to avoid ArgoCD ownership conflicts. If `perses` is ever deployed independently without `logging`, those files must be re-enabled. Leave no json files at the folder. Otherwise the argocd will not work.

### Manual prerequisites (one-time, before first ArgoCD sync)

One step cannot be automated due to a current COO limitation:

#### Fix Perses StorageClass after UIPlugin sync

COO creates the `Perses` CR automatically when UIPlugin is applied, but does not set a StorageClass on the PVC — a known COO limitation. StatefulSet `volumeClaimTemplates` are immutable, so the StorageClass must be patched onto the Perses CR **before** the StatefulSet is created, then the StatefulSet and PVC must be deleted to force recreation with the correct template.

After the UIPlugin sync completes, run:

```bash
# Install plugin
oc apply -f UIPlugin:monitoring.yaml

# Patch the StorageClass onto the Perses CR
oc patch perses/perses \
  -n openshift-cluster-observability-operator \
  --type=merge \
  -p '{"spec":{"storage":{"size":"2Gi","storageClass":"ocs-storagecluster-cephfs"}}}'

# Delete the StatefulSet so the operator recreates it from the patched Perses CR
# (volumeClaimTemplates are immutable — the StatefulSet must be recreated, not updated)
oc delete statefulset perses \
  -n openshift-cluster-observability-operator

# Delete the PVC so it is recreated from the new StatefulSet's volumeClaimTemplate
oc delete pvc storage-perses-0 \
  -n openshift-cluster-observability-operator --ignore-not-found

# Wait for pod to become ready
oc wait --for=condition=Ready pod/perses-0 \
  -n openshift-cluster-observability-operator \
  --timeout=120s
```

> To use a different StorageClass, replace `ocs-storagecluster-cephfs` with the output of `oc get storageclass`.

Perses is now available in the OpenShift console under **Observe → Dashboards (Perses)**.

---

## Datasource Authentication

The `PersesDatasource:openshift-monitoring.yaml` references `openshift-monitoring-secret`. This is **not a Kubernetes Secret** — it is a Perses-internal secret stored automatically on the Perses PVC at:

```
/perses/secrets/openshift-perses/openshift-monitoring-secret.yaml
```

It contains only TLS configuration:

```yaml
spec:
  tlsConfig:
    caFile: /ca/service-ca.crt
```

This provides the OpenShift service CA certificate so Perses can verify Thanos Querier's TLS certificate. The CA file is mounted into the Perses pod by COO at `/ca/service-ca.crt`.

Authentication to Thanos Querier is handled via the Perses pod's own service account token (`perses-sa`), which COO grants the necessary RBAC permissions through the `perses-cr` ClusterRole.

To verify the secret is present:

```bash
oc exec -n openshift-cluster-observability-operator perses-0 \
  -- cat /perses/secrets/openshift-perses/openshift-monitoring-secret.yaml
```

---

## Dashboard Storage

Perses has two separate storage backends — it is critical to understand the difference:

| | Kubernetes CR | Perses internal (PVC) |
|:---|:---|:---|
| Created by | ArgoCD / `oc apply -f` | `percli apply` / UI import |
| Visible as | `oc get persesdashboard` | only via API / percli |
| Survives PVC loss | ✅ yes (etcd) | ❌ no |
| GitOps managed | ✅ yes | ❌ no |
| Storage location | etcd | `/perses/dashboards/` on CephFS PVC |

**Dashboards imported via UI or `percli apply` are NOT Kubernetes resources.** They are stored only on the Perses PVC and will be lost if the PVC is deleted.

### GitOps Workflow — UI → Git → Cluster

The OCP console UI supports exporting dashboards in multiple formats. Use **YAML CR (v1alpha2)** to get a file ready for ArgoCD:

1. Open dashboard in OCP console → **Observe → Dashboards**
2. Click **Export** → select **YAML CR (v1alpha2)**
3. Save as `PersesDashboard:<name>.yaml`, add sync-wave and labels to match existing dashboards, commit to Git
4. ArgoCD will apply it on next sync

### Datasource References — Do Not Use Hardcoded UIDs

Dashboards exported from the UI or migrated from Grafana may contain a hardcoded datasource UID inside each `PrometheusTimeSeriesQuery` spec:

```yaml
spec:
  plugin:
    kind: PrometheusTimeSeriesQuery
    spec:
      datasource:          # ← remove this block
        kind: PrometheusDatasource
      query: ...
```

They may also contain a `variables` section with a `DatasourceVariable` whose `defaultValue` is that UID:

```yaml
variables:
  - kind: ListVariable
    spec:
      defaultValue: 7ffcebfd-12384-4730-b1d0-b5adeed77ceasd  # ← environment-specific, will not resolve
      plugin:
        kind: DatasourceVariable
        spec:
          datasourcePluginKind: PrometheusDatasource
```

Both cause all panel queries to fail silently because the UID is tied to the environment where the dashboard was originally created and does not exist in this cluster's Perses instance.

**Fix:** remove the `datasource:` block from every `PrometheusTimeSeriesQuery` spec and delete the broken `variables` section. Perses will then resolve queries against the globally configured `PersesDatasource` automatically.

If a dashboard legitimately needs a datasource picker variable (e.g. multi-cluster), define a proper named `DatasourceVariable` with `defaultValue` set to the datasource **display name** (e.g. `Cluster Prometheus`), not a UID:

```yaml
variables:
  - kind: ListVariable
    spec:
      name: datasource
      defaultValue: Cluster Prometheus
      plugin:
        kind: DatasourceVariable
        spec:
          datasourcePluginKind: PrometheusDatasource
```

