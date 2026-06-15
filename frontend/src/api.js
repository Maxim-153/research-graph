import axios from 'axios';

// HTTP-клиент для обращения к серверной части (FastAPI)
const apiClient = axios.create({
    baseURL: import.meta.env.VITE_API_URL || '',
    headers: {
        'Content-Type': 'application/json',
    },
});

// Запрос данных графа по теме (диапазон лет и порядок сортировки)
export const fetchGraphData = async (searchQuery, yearFrom, yearTo, sortMode = 'relevance') => {
    try {
        // 1. Формируем базовый объект с параметрами (запрос обязателен)
        const queryParams = { query: searchQuery, sort: sortMode };
        
        // Границы лет добавляем только если заданы и приводим к числу.
        if (yearFrom) {
            queryParams.year_from = parseInt(yearFrom, 10);
        }
        if (yearTo) {
            queryParams.year_to = parseInt(yearTo, 10);
        }

        // 3. Делаем GET-запрос. Axios сам склеит URL, например:
        // http://127.0.0.1:8000/api/search?query=Block&year_from=2020
        const response = await apiClient.get('/api/search', {
            params: queryParams
        });
        
        // Возвращаем узлы и рёбра графа
        return response.data;
        
    } catch (error) {
        // Перехват ошибок запроса
        console.error("Ошибка при получении данных с бэкенда:", error);
        throw error;
    }
};
export const expandGraphData = async (paperId) => {
    try {
        // Делаем GET-запрос на наш новый эндпоинт, передавая ID статьи
        const response = await apiClient.get('/api/expand', {
            params: { paper_id: paperId }
        });
        
        // Возвращаем новые узлы и рёбра
        return response.data;
        
    } catch (error) {
        // Обязательный перехват ошибок
        console.error(`Ошибка при расширении графа для статьи ${paperId}:`, error);
        throw error;
    }
};
