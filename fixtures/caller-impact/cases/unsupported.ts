export async function unsupportedEvaluation() {
  const response = await fetch('/orders/current');
  const order = await response.json();
  return eval(order.customerName);
}
