import { useLayoutEffect, useRef, useState } from "react";

import type { ArtifactElement, ArtifactElementsResult } from "../../lib/artifactReview/types";
import { cn } from "../../lib/shared/utils";
import { containedImageRect, elementBoxPercent } from "./selectionState";

/** Semantic context targets only: no drag handles or in-place document editing. */
export function ElementOverlay(props: {
  imageSrc: string;
  label: string;
  elements: ArtifactElementsResult | null;
  selectedId: string | null;
  loading: boolean;
  onSelect: (element: ArtifactElement) => void;
  onSelectUnit: () => void;
}) {
  const { imageSrc, label, elements, selectedId, loading, onSelect, onSelectUnit } = props;
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ src: "", width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      setFrame({ width: bounds.width, height: bounds.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const rect = natural.src === imageSrc ? containedImageRect(frame, natural) : null;
  // Smaller semantic targets sit above larger ones where their boxes overlap.
  const targets = [...(elements?.elements ?? [])].sort(
    (a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3],
  );

  return (
    <div ref={frameRef} className="relative h-full min-h-0 w-full min-w-0">
      <img
        src={imageSrc}
        alt={label}
        className={cn(
          "pointer-events-none h-full w-full select-none object-contain transition-opacity",
          loading && "opacity-60",
        )}
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget;
          setNatural({ src: imageSrc, width: image.naturalWidth, height: image.naturalHeight });
        }}
      />
      {rect ? (
        <div className="pointer-events-none absolute" style={rect}>
          <button
            type="button"
            className="pointer-events-auto absolute inset-0 rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
            aria-label={label}
            onClick={onSelectUnit}
            disabled={loading}
          />
          {!loading && elements
            ? targets.map((element) => {
                const box = elementBoxPercent(element.bbox, elements.canvas);
                if (!box) return null;
                const selected = selectedId === element.id;
                const title = `${element.type} · ${element.label || element.id}`;
                return (
                  <button
                    key={element.id}
                    type="button"
                    title={title}
                    aria-label={title}
                    aria-pressed={selected}
                    data-element-id={element.id}
                    className={cn(
                      "pointer-events-auto absolute cursor-pointer rounded-sm border-2 text-left transition-colors focus-visible:border-primary focus-visible:bg-primary/10 focus-visible:outline-none",
                      selected
                        ? "border-primary bg-primary/10 shadow-[0_0_0_1px_white]"
                        : "border-transparent hover:border-primary/70 hover:bg-primary/10",
                    )}
                    style={box}
                    onClick={() => onSelect(element)}
                  />
                );
              })
            : null}
        </div>
      ) : null}
    </div>
  );
}
