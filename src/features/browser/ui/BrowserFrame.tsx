import { browserFrameSandbox } from "../model/browserUrl";

/**
 * Pages run scripts and submit forms, and nothing more: no
 * `allow-top-navigation`, so a page can't replace the app, and no
 * `allow-popups`, so `window.open` stays inert. `browserFrameSandbox` decides
 * whether the page keeps its own origin.
 */
type Props = {
  src: string;
  title: string;
};

export function BrowserFrame({ src, title }: Props) {
  return (
    <iframe
      src={src}
      title={title}
      sandbox={browserFrameSandbox(src, window.location.origin)}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}
