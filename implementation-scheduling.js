"use strict";

function criticalPathTaskIds(tasks, dependencies) {
  const openTasks = tasks.filter((task) => task.status !== "done");
  if (!openTasks.length) return new Set();

  const taskById = new Map(openTasks.map((task) => [Number(task.id), task]));
  const successors = new Map([...taskById.keys()].map((id) => [id, []]));
  const indegree = new Map([...taskById.keys()].map((id) => [id, 0]));
  for (const dependency of dependencies) {
    const taskId = Number(dependency.implementation_step_id ?? dependency.step_id);
    const prerequisiteId = Number(dependency.depends_on_step_id ?? dependency.dependsOnStepId);
    if (!taskById.has(taskId) || !taskById.has(prerequisiteId)) continue;
    successors.get(prerequisiteId).push(taskId);
    indegree.set(taskId, indegree.get(taskId) + 1);
  }

  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const successor of successors.get(id)) {
      indegree.set(successor, indegree.get(successor) - 1);
      if (indegree.get(successor) === 0) queue.push(successor);
    }
  }
  if (order.length !== openTasks.length) throw new Error("Implementation task prerequisites contain a cycle.");

  const duration = (id) => {
    const days = Number(taskById.get(id).estimated_duration_days ?? taskById.get(id).estimatedDurationDays ?? 1);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new RangeError("Task duration must be a whole number from 1 to 3650 days.");
    }
    return days;
  };
  const longestTo = new Map();
  for (const id of order) {
    const longestPrerequisite = dependencies
      .filter((dependency) => Number(dependency.implementation_step_id ?? dependency.step_id) === id)
      .map((dependency) => Number(dependency.depends_on_step_id ?? dependency.dependsOnStepId))
      .filter((prerequisiteId) => longestTo.has(prerequisiteId))
      .reduce((longest, prerequisiteId) => Math.max(longest, longestTo.get(prerequisiteId)), 0);
    longestTo.set(id, longestPrerequisite + duration(id));
  }

  const longestFrom = new Map();
  for (const id of [...order].reverse()) {
    const longestSuccessor = successors.get(id)
      .reduce((longest, successorId) => Math.max(longest, longestFrom.get(successorId)), 0);
    longestFrom.set(id, duration(id) + longestSuccessor);
  }

  const totalDuration = Math.max(...longestTo.values());
  return new Set([...taskById.keys()].filter((id) =>
    longestTo.get(id) + longestFrom.get(id) - duration(id) === totalDuration));
}

function overdueCriticalClientTaskIds(tasks, dependencies, utcDate) {
  const critical = criticalPathTaskIds(tasks, dependencies);
  return new Set(tasks.filter((task) =>
    critical.has(Number(task.id))
    && task.status !== "done"
    && task.responsible_party === "client"
    && typeof task.due_at === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(task.due_at)
    && task.due_at < utcDate
  ).map((task) => Number(task.id)));
}

module.exports = { criticalPathTaskIds, overdueCriticalClientTaskIds };
