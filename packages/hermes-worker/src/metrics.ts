/**
 * CloudWatch custom metrics for the Hermes PR pipeline (namespace DonateMate/Hermes).
 *
 * Baseline before these enhancements (measure staging for one week against it):
 *   - avg ~2.4 CI fix cycles/PR (worst 6)
 *   - ~3 blocking human review findings/PR
 *   - 0% of shipped PRs had locally-executed tests
 *
 * Metrics emitted:
 *   HermesGateCycles      — pre-commit gate iterations run before a PR opened (WS2)
 *   HermesCiFixAttempts   — post-open CI/review auto-repair rounds (existing loop; also emitted here)
 *   HermesPreopenFindings — findings raised by the pre-open adversarial review (WS4)
 *   HermesPreopenBlocking — of those, how many were BLOCKING (WS4)
 *   HermesInstallSeconds  — workspace dependency-install wall time (WS1)
 *   HermesGateFailShipped — 1 when a PR opened WITH unresolved gate failures (fail-open)
 *   HermesAgentProviderFallback — jobs completed through the secondary coding provider
 *   HermesProviderUnavailable  — jobs preserved because neither coding provider was available
 *   HermesProviderBillingBlocked — first observation of a durable model-provider billing incident
 *   HermesProviderBillingRecovered — preserved job resumed after provider billing recovered
 *
 * Best-effort: metric publishing never throws into the job pipeline.
 */
import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';

const NAMESPACE = process.env.HERMES_METRICS_NAMESPACE || 'DonateMate/Hermes';
const ENVIRONMENT = process.env.ENVIRONMENT || 'staging';
const cw = new CloudWatchClient({});

export type HermesMetric =
  | 'HermesGateCycles'
  | 'HermesCiFixAttempts'
  | 'HermesPreopenFindings'
  | 'HermesPreopenBlocking'
  | 'HermesInstallSeconds'
  | 'HermesGateFailShipped'
  | 'HermesAgentProviderFallback'
  | 'HermesProviderUnavailable'
  | 'HermesProviderBillingBlocked'
  | 'HermesProviderBillingRecovered';

/**
 * Publish one metric datum. `repo` and `type` (fe/be) are attached as dimensions so the dashboard
 * can slice per-repo. Also emits an undimensioned copy so aggregate widgets work.
 */
export async function putMetric(
  metric: HermesMetric,
  value: number,
  opts: { repo?: string; type?: string; unit?: StandardUnit } = {}
): Promise<void> {
  const unit = opts.unit ?? (metric === 'HermesInstallSeconds' ? StandardUnit.Seconds : StandardUnit.Count);
  const common = { MetricName: metric, Value: value, Unit: unit };
  const dims = [{ Name: 'Environment', Value: ENVIRONMENT }];
  if (opts.type) dims.push({ Name: 'Type', Value: opts.type });
  try {
    await cw.send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: [
          { ...common, Dimensions: dims },
          { ...common, Dimensions: [{ Name: 'Environment', Value: ENVIRONMENT }] },
        ],
      })
    );
  } catch (err) {
    console.warn(`[metrics] failed to publish ${metric}:`, err instanceof Error ? err.message : String(err));
  }
}
