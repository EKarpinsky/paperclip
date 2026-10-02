import { classifyShellRoute } from "../lib/shell-navigation";
import { useClassicTaskInterfaceEnabled } from "./useClassicTaskInterfaceEnabled";

/**
 * Whether a mobile task page keeps a fixed bottom padding and slides down with
 * the auto-hiding bottom nav, instead of swapping its padding when the nav
 * toggles. Swapping the padding resizes the page, which moves the scroll
 * position, which toggles the nav again.
 *
 * The Classic Task Interface is the exception: its composer docks at a fixed
 * offset that doesn't follow the nav, so sliding the page would push it below
 * the viewport. It only renders on issue routes; chats always use the chat
 * shell.
 */
export function useTaskPageSlidesWithMobileNav(pathname: string, companyPrefix: string | undefined): boolean {
  const { enabled: classicTaskInterfaceEnabled } = useClassicTaskInterfaceEnabled();
  const route = classifyShellRoute(pathname, companyPrefix);
  const rendersClassicThread = classicTaskInterfaceEnabled && route.companySegments[0]?.toLowerCase() === "issues";
  return route.isTaskDetail && !rendersClassicThread;
}
