"""
Построение типизированных рёбер графа публикаций и метрики связности.

Единый источник правды для топологии графа: модуль используется и сервером
(`main.py` при сборке ответа), и eval-харнессом (`eval_metrics.py` для замера
связности в трёх конфигурациях). Так формулы рёбер описаны и вычисляются в
одном месте.

Три типа связей между статьями:
  * citation  — A цитирует B (B присутствует в выдаче). Направленное ребро A→B.
  * coupling  — библиографическое сопряжение: A и B ссылаются на общие работы.
                Вес = размер пересечения их списков литературы (referenced_works).
  * semantic  — семантическая близость: kNN по косинусу эмбеддингов запроса.
                Вес = косинусная близость [0, 1].

build_all_edges() объединяет рёбра разных типов между одной парой статей в ОДНО
ребро с полем `kinds` (одна линия на пару — так граф читается). Приоритет для
направления/стиля: citation > coupling > semantic.
"""
import numpy as np

# Порядок приоритета типов рёбер (для направления и выбора основного стиля).
KIND_PRIORITY = ("citation", "coupling", "semantic")


def _paper_refs(papers):
    """Словарь paperId -> множество referenced_works (id цитируемых работ)."""
    refs = {}
    for paper in papers:
        pid = paper.get("paperId")
        if not pid:
            continue
        refs[pid] = {
            c.get("paperId")
            for c in paper.get("citations", [])
            if c.get("paperId")
        }
    return refs


def citation_edges(papers, paper_ids):
    """Рёбра прямого цитирования: A→B, если A цитирует B и B есть в выдаче."""
    edges = []
    for paper in papers:
        src = paper.get("paperId")
        if not src:
            continue
        for citation in paper.get("citations", []):
            tgt = citation.get("paperId")
            if tgt and tgt != src and tgt in paper_ids:
                edges.append({"source": src, "target": tgt, "kind": "citation", "weight": 1})
    return edges


def coupling_edges(papers, min_shared=2, top_k=None):
    """
    Рёбра библиографического сопряжения: пара статей связана, если их списки
    литературы пересекаются не меньше чем на `min_shared` работ. Вес = размер
    пересечения. Связь ненаправленная.

    top_k=None — все пары (нужно для честной метрики связности в eval).
    top_k=N    — для каждой статьи оставляем только N сильнейших сопряжений (по числу
                 общих источников), чтобы не перегружать граф визуально (для отображения).
    """
    refs = _paper_refs(papers)
    ids = [pid for pid, works in refs.items() if works]

    if top_k is None:
        edges = []
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                shared = len(refs[ids[i]] & refs[ids[j]])
                if shared >= min_shared:
                    edges.append({"source": ids[i], "target": ids[j], "kind": "coupling", "weight": shared})
        return edges

    # top_k: для каждой статьи берём сильнейших соседей по числу общих источников.
    neighbors = {pid: [] for pid in ids}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            shared = len(refs[ids[i]] & refs[ids[j]])
            if shared >= min_shared:
                neighbors[ids[i]].append((shared, ids[j]))
                neighbors[ids[j]].append((shared, ids[i]))

    seen = set()
    edges = []
    for pid in ids:
        for shared, other in sorted(neighbors[pid], key=lambda x: x[0], reverse=True)[:top_k]:
            key = tuple(sorted((pid, other)))
            if key in seen:
                continue
            seen.add(key)
            edges.append({"source": pid, "target": other, "kind": "coupling", "weight": shared})
    return edges


def semantic_edges(papers, k=3, min_sim=0.5):
    """
    Рёбра семантической близости: для каждой статьи берём до `k` ближайших по
    косинусу соседей с близостью не ниже `min_sim`. Эмбеддинги ожидаются уже
    L2-нормализованными (как их кладёт ml_processor.process_clusters), поэтому
    косинус = скалярное произведение. Связь ненаправленная, дубликаты пар убираются.
    """
    indexed = [
        (paper.get("paperId"), paper.get("embedding"))
        for paper in papers
        if paper.get("paperId") and paper.get("embedding") is not None
    ]
    if len(indexed) < 2:
        return []

    ids = [pid for pid, _ in indexed]
    matrix = np.asarray([emb for _, emb in indexed], dtype=float)
    sims = matrix @ matrix.T  # косинусная матрица (эмбеддинги нормализованы)

    seen = set()
    edges = []
    n = len(ids)
    for i in range(n):
        order = np.argsort(sims[i])[::-1]  # индексы соседей по убыванию близости
        added = 0
        for j in order:
            if j == i:
                continue
            if added >= k:
                break
            sim = float(sims[i][j])
            if sim < min_sim:
                break  # дальше только меньше — выходим
            key = tuple(sorted((ids[i], ids[j])))
            if key in seen:
                continue
            seen.add(key)
            edges.append({"source": ids[i], "target": ids[j], "kind": "semantic", "weight": round(sim, 3)})
            added += 1
    return edges


def build_all_edges(papers, paper_ids=None, coupling_min_shared=2, coupling_top_k=3, knn_k=3, knn_min_sim=0.5):
    """
    Собирает все типы рёбер ДЛЯ ОТОБРАЖЕНИЯ и объединяет связи одной пары статей в
    одно ребро. Coupling и semantic прорежены до сильнейших на статью (coupling_top_k,
    knn_k), чтобы граф не превращался в паутину. Полные (непрореженные) наборы для
    метрики связности eval строит отдельными вызовами citation/coupling/semantic_edges.

    Возвращает список словарей вида:
        {"source", "target", "kinds": [...], "weights": {kind: weight}}
    где `kinds` упорядочен по приоритету (citation > coupling > semantic), а
    направление (source→target) берётся от citation, если оно есть.
    """
    if paper_ids is None:
        paper_ids = {p.get("paperId") for p in papers if p.get("paperId")}

    merged = {}  # ключ: отсортированная пара id -> объединённое ребро

    def add(edge, directed):
        key = tuple(sorted((edge["source"], edge["target"])))
        entry = merged.get(key)
        if entry is None:
            entry = {"source": edge["source"], "target": edge["target"], "kinds": [], "weights": {}}
            merged[key] = entry
        if directed:
            # citation задаёт направление пары
            entry["source"], entry["target"] = edge["source"], edge["target"]
        kind = edge["kind"]
        if kind not in entry["kinds"]:
            entry["kinds"].append(kind)
        entry["weights"][kind] = edge["weight"]

    # Порядок добавления = порядок приоритета в `kinds`.
    for edge in citation_edges(papers, paper_ids):
        add(edge, directed=True)
    for edge in coupling_edges(papers, min_shared=coupling_min_shared, top_k=coupling_top_k):
        add(edge, directed=False)
    for edge in semantic_edges(papers, k=knn_k, min_sim=knn_min_sim):
        add(edge, directed=False)

    # Упорядочим kinds по глобальному приоритету (на случай разного порядка вставки).
    for entry in merged.values():
        entry["kinds"].sort(key=lambda kind: KIND_PRIORITY.index(kind))

    return list(merged.values())


def connectivity_stats(node_ids, edges):
    """
    Метрики связности НЕориентированного графа по списку рёбер:
      * isolated_frac — доля узлов без единого ребра;
      * components    — число компонент связности;
      * avg_degree    — средняя степень узла.
    Рёбра — любой формат с ключами source/target (тип не важен).
    """
    node_ids = list(node_ids)
    index = {nid: i for i, nid in enumerate(node_ids)}
    n = len(node_ids)
    if n == 0:
        return {"n_nodes": 0, "isolated_frac": 0.0, "components": 0, "avg_degree": 0.0}

    adjacency = {i: set() for i in range(n)}
    for edge in edges:
        s = index.get(edge["source"])
        t = index.get(edge["target"])
        if s is None or t is None or s == t:
            continue
        adjacency[s].add(t)
        adjacency[t].add(s)

    degrees = [len(adjacency[i]) for i in range(n)]
    isolated = sum(1 for d in degrees if d == 0)

    seen = set()
    components = 0
    for start in range(n):
        if start in seen:
            continue
        components += 1
        stack = [start]
        while stack:
            v = stack.pop()
            if v in seen:
                continue
            seen.add(v)
            stack.extend(adjacency[v] - seen)

    return {
        "n_nodes": n,
        "isolated_frac": round(isolated / n, 3),
        "components": components,
        "avg_degree": round(sum(degrees) / n, 2),
    }
