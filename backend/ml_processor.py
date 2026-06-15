from sentence_transformers import SentenceTransformer
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import normalize
from sklearn.feature_extraction.text import TfidfVectorizer, ENGLISH_STOP_WORDS
import numpy as np

# Компактная модель векторизации текстов (загружается один раз при импорте)
print("Загрузка ML-модели...")
model = SentenceTransformer('all-MiniLM-L6-v2')
print("Модель готова!")

# Базовый список русских стоп-слов (дополняет английский)
RU_STOP_WORDS = [
    "на", "от", "для", "из", "по", "как", "что", "это", "или", "при", 
    "то", "за", "об", "до", "со", "же", "вы", "мы", "они", "он", "она"
]

# Объединяем английский и русский словари
COMBINED_STOP_WORDS = list(ENGLISH_STOP_WORDS) + RU_STOP_WORDS


def paper_text(paper):
    """Текст статьи для эмбеддинга: аннотация, иначе заголовок."""
    return (paper.get("abstract") or paper.get("title") or "").strip()


def rerank_by_query(query, papers):
    """
    Семантическое ре-ранжирование выдачи: сортирует статьи по косинусной близости
    их текстов к эмбеддингу поискового запроса. Каждой статье добавляет поле
    semantic_score в диапазоне [0, 1].

    Исходная (лексическая) выдача OpenAlex пересортировывается по смысловой
    близости к запросу. Статьи без текста уходят в конец с semantic_score = 0.
    """
    if not query or not query.strip() or not papers:
        return papers

    text_indices = [(i, paper_text(p)) for i, p in enumerate(papers)]
    with_text = [(i, text) for i, text in text_indices if text]
    if not with_text:
        return papers

    query_embedding = model.encode([query])
    doc_embeddings = model.encode([text for _, text in with_text])
    similarities = cosine_similarity(query_embedding, doc_embeddings)[0]

    scores = {}
    for (i, _), sim in zip(with_text, similarities):
        # косинус из [-1, 1] приводим к [0, 1] для удобной интерпретации
        scores[i] = round(float((sim + 1.0) / 2.0), 4)

    for i, paper in enumerate(papers):
        paper["semantic_score"] = scores.get(i, 0.0)

    return sorted(papers, key=lambda p: p.get("semantic_score", 0.0), reverse=True)

def get_cluster_name(abstracts, top_k=3):
    """
    Формирует название кластера из наиболее характерных терминов его текстов.
    """
    valid_texts = [text for text in abstracts if text and len(text.strip()) > 0]
    if not valid_texts:
        return "Разное"

    try:
        vectorizer = TfidfVectorizer(
            stop_words=COMBINED_STOP_WORDS,
            max_features=1000,
            token_pattern=r'(?u)\b[a-zA-Zа-яА-ЯёЁ]{3,}\b' # Только слова из 3 и более букв
        )
        tfidf_matrix = vectorizer.fit_transform(valid_texts)
        feature_names = vectorizer.get_feature_names_out()
        
        # После фильтрации стоп-слов не осталось термов
        if len(feature_names) == 0:
            return "Общая тема"
        
        summed_tfidf = np.sum(tfidf_matrix, axis=0)
        top_indices = np.argsort(summed_tfidf).A1[-top_k:][::-1]
        
        top_words = [feature_names[i] for i in top_indices]
        return ", ".join(top_words).title()
    
    except Exception as e:
        print(f"Ошибка при генерации имени: {e}")
        return "Группа статей"

def choose_clusters(embeddings, k_min=2, k_max=8):
    """
    Подбирает число кластеров k по максимуму коэффициента силуэта.

    Перебирает k от k_min до min(k_max, n-1), для каждого считает KMeans и
    силуэт, возвращает разметку с лучшим силуэтом.
    Возвращает кортеж (labels, k, silhouette). silhouette = None, если точек
    слишком мало для осмысленной кластеризации (тогда всё в одной группе).
    """
    n = len(embeddings)
    # Силуэт определён только при 2 <= k <= n-1, поэтому для n<=2 кластеризовать нечего
    if n <= 2:
        return [0] * n, 1, None

    # Sentence-эмбеддинги калиброваны под косинусную близость: L2-нормализация
    # делает евклидов KMeans эквивалентным сферической (косинусной) кластеризации.
    embeddings = normalize(embeddings)

    upper = min(k_max, n - 1)
    best_labels, best_k, best_score = None, 1, -1.0

    for k in range(max(2, k_min), upper + 1):
        kmeans = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels = kmeans.fit_predict(embeddings)
        # Если KMeans свёл все точки в один кластер — силуэт не определён
        if len(set(labels)) < 2:
            continue
        score = silhouette_score(embeddings, labels)
        if score > best_score:
            best_labels, best_k, best_score = labels, k, score

    if best_labels is None:
        return [0] * n, 1, None

    return best_labels, best_k, best_score


def process_clusters(papers, num_clusters=None):
    """
    Принимает список статей, векторизует и кластеризует их, затем даёт группам
    человекочитаемые названия (TF-IDF).

    num_clusters=None (по умолчанию) — число кластеров подбирается автоматически
    по силуэту. Если передано целое — используется фиксированное k (для сравнения
    в экспериментах «Анализа результатов»).
    """
    texts = []
    valid_papers = []

    # 1. Подготавливаем тексты (аннотация, иначе заголовок)
    for paper in papers:
        text = paper_text(paper)
        if text:
            texts.append(text)
            valid_papers.append(paper)

    if not texts:
        return papers

    # 2. Векторизация (+ L2-нормализация для косинусной кластеризации)
    embeddings = normalize(model.encode(texts))

    # 3. Кластеризация: авто-подбор k по силуэту или фиксированное k
    if num_clusters is not None:
        k = max(1, min(num_clusters, len(texts)))
        if k == 1:
            labels, silhouette = [0] * len(texts), None
        else:
            labels = KMeans(n_clusters=k, random_state=42, n_init=10).fit_predict(embeddings)
            silhouette = silhouette_score(embeddings, labels) if len(set(labels)) > 1 else None
    else:
        labels, k, silhouette = choose_clusters(embeddings)

    silhouette_text = round(float(silhouette), 3) if silhouette is not None else "n/a"
    print(f"--- [ML] Кластеров (k): {k}, силуэт: {silhouette_text} ---")

    # 4. Группируем тексты по меткам кластеров (для TF-IDF-именования)
    cluster_texts_dict = {}
    for text, label in zip(texts, labels):
        cluster_texts_dict.setdefault(int(label), []).append(text)

    # 5. Генерируем названия для каждой группы
    cluster_names_dict = {
        cluster_id: get_cluster_name(c_texts)
        for cluster_id, c_texts in cluster_texts_dict.items()
    }

    # 6. Записываем в каждую статью номер группы, название и L2-нормализованный эмбеддинг.
    #    Эмбеддинг нужен для семантических (kNN) рёбер графа (см. graph_edges.py);
    #    в данные узла он не попадает — main.py собирает узлы по явному списку полей.
    for i, (paper, label) in enumerate(zip(valid_papers, labels)):
        c_id = int(label)
        paper["group"] = c_id
        paper["group_name"] = cluster_names_dict[c_id]
        paper["embedding"] = embeddings[i].tolist()

    return valid_papers