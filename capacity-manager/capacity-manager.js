
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const QUEUE_FILE = "./capacity-manager/queue.json";
const NAMESPACE = "nasiko-demo";
const DEPLOYMENT = "agent-simulator";

const AGENT_CPU_MILLICORES = 250;
const AGENT_MEMORY_MIB = 200;

function kubectl(args) {
  return execFileSync("kubectl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function loadQueue() {
  return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
}

function saveQueue(queue) {
  fs.writeFileSync(
    QUEUE_FILE,
    JSON.stringify(queue, null, 2)
  );
}

function getQuota() {
  const output = kubectl([
    "get",
    "resourcequota",
    "agent-demo-quota",
    "-n",
    NAMESPACE,
    "-o",
    "json"
  ]);

  const quota = JSON.parse(output);
  const hard = quota.status?.hard || {};
  const used = quota.status?.used || {};

  return {
    cpuLimit: parseCpu(hard["limits.cpu"]),
    cpuUsed: parseCpu(used["limits.cpu"]),
    memoryLimit: parseMemory(hard["limits.memory"]),
    memoryUsed: parseMemory(used["limits.memory"]),
    podLimit: Number(hard.pods || 0),
    podUsed: Number(used.pods || 0)
  };
}

function parseCpu(value = "0") {
  if (value.endsWith("m")) {
    return Number(value.slice(0, -1));
  }

  return Number(value) * 1000;
}

function parseMemory(value = "0") {
  if (value.endsWith("Gi")) {
    return Number(value.slice(0, -2)) * 1024;
  }

  if (value.endsWith("Mi")) {
    return Number(value.slice(0, -2));
  }

  return Number(value);
}

function getDeploymentStatus() {
  const output = kubectl([
    "get",
    "deployment",
    DEPLOYMENT,
    "-n",
    NAMESPACE,
    "-o",
    "json"
  ]);

  const deployment = JSON.parse(output);
  const status = deployment.status || {};

  return {
    desired: status.replicas || 0,
    available: status.availableReplicas || 0
  };
}

function canAdmitAgent(quota) {
  return (
    quota.cpuUsed + AGENT_CPU_MILLICORES <= quota.cpuLimit &&
    quota.memoryUsed + AGENT_MEMORY_MIB <= quota.memoryLimit &&
    quota.podUsed + 1 <= quota.podLimit
  );
}

function printStatus(queue, deployment, quota) {
  console.log("\n=== Agent Capacity Manager ===");

  console.log(`Desired replicas: ${deployment.desired}`);
  console.log(`Available agents: ${deployment.available}`);

  console.log(
    `CPU quota: ${quota.cpuUsed}m / ${quota.cpuLimit}m`
  );

  console.log(
    `Memory quota: ${quota.memoryUsed}Mi / ${quota.memoryLimit}Mi`
  );

  console.log(
    `Pods quota: ${quota.podUsed} / ${quota.podLimit}`
  );

  console.log(`Queued agents: ${queue.queuedAgents.length}`);
}

function reconcile() {
  const queue = loadQueue();
  const deployment = getDeploymentStatus();
  const quota = getQuota();

  queue.runningAgents = deployment.available;

  if (queue.queuedAgents.length === 0) {
    console.log("No queued agents.");
    return;
  }

  const nextAgent = queue.queuedAgents[0];

  console.log(`\nNext queued agent: ${nextAgent.id}`);

  if (!canAdmitAgent(quota)) {
    console.log(
      "Capacity unavailable. Keeping agent in queue."
    );

    printStatus(queue, deployment, quota);
    saveQueue(queue);
    return;
  }

  console.log(
    `Capacity available. Admitting ${nextAgent.id}.`
  );

  const newReplicaCount = deployment.desired + 1;

  kubectl([
    "scale",
    "deployment",
    DEPLOYMENT,
    "-n",
    NAMESPACE,
    `--replicas=${newReplicaCount}`
  ]);

  nextAgent.status = "admission-requested";
  nextAgent.admittedAt = new Date().toISOString();

  queue.queuedAgents.shift();
  queue.runningAgents += 1;

  saveQueue(queue);

  console.log(
    `Admission requested for ${nextAgent.id}.`
  );
}

const watchMode = process.argv.includes("--watch") || process.argv.includes("-w");
const pollIntervalMs = 3000;

if (watchMode) {
  console.log("=== Agent Capacity Observer Daemon Started (polling every 3s) ===");
  console.log("Monitoring K8s ResourceQuota and queue.json continuously...\n");
  
  // Run once immediately, then poll
  try {
    reconcile();
  } catch (err) {
    console.error("[Observer Error]:", err.message);
  }

  setInterval(() => {
    try {
      reconcile();
    } catch (error) {
      console.error("[Observer Error]:", error.message);
    }
  }, pollIntervalMs);
} else {
  try {
    reconcile();
  } catch (error) {
    console.error("\nCapacity manager failed:");
    console.error(error.message);
    process.exitCode = 1;
  }
}